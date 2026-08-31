import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { FsBlobStore } from '../src/blobs/index.js';
import { BlobMissingError } from '../src/contracts/errors.js';

function tmpStore(): FsBlobStore {
  return new FsBlobStore(mkdtempSync(join(tmpdir(), 'ct-blobs-')));
}

function sha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('digest', () => {
  it('computes the ref without writing, so callers can dedup before storing', () => {
    const store = tmpStore();
    const ref = store.digest('hello world');
    expect(ref).toBe(sha256('hello world'));
    expect(store.has(ref)).toBe(false);
  });
});

describe('put — content addressing and write-once', () => {
  it('gives identical content the same ref (structural sharing, D8)', () => {
    const store = tmpStore();
    const a = store.put('same content');
    const b = store.put('same content');
    expect(a).toBe(b);
  });

  it('does not rewrite an existing blob on a second put of the same content', () => {
    // Write-once matters because L2 is meant to be append-only-by-hash: a
    // rewrite here would mean the store does needless I/O (or worse, could
    // race and corrupt) every time two nodes reference the same content.
    const store = tmpStore();
    const ref = store.put('stable body');
    const path = store.pathFor(ref);
    const mtimeBefore = statSync(path).mtimeMs;

    store.put('stable body');
    const mtimeAfter = statSync(path).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });

  it('never overwrites a pre-seeded file at the ref path even if its body differs', () => {
    // Simulates a corrupted/foreign file already sitting at the content
    // address. put() must treat "path exists" as authoritative and never
    // clobber it — silent overwrite is exactly the corruption mode a
    // content-addressed store is supposed to make impossible.
    const store = tmpStore();
    const content = 'real content';
    const ref = sha256(content);
    const dir = join(store.root, ref.slice(0, 2));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ref.slice(2)), 'pre-seeded different body');

    const returned = store.put(content);
    expect(returned).toBe(ref);
    expect(store.getText(ref)).toBe('pre-seeded different body');
  });

  it('shards the file under the first two hex chars of its ref', () => {
    const store = tmpStore();
    const ref = store.put('shard me');
    const expectedPath = join(store.root, ref.slice(0, 2), ref.slice(2));
    expect(store.pathFor(ref)).toBe(expectedPath);
    expect(() => readFileSync(expectedPath)).not.toThrow();
  });

  it('writes atomically (no .tmp file left behind after a successful put)', () => {
    // Atomicity is implemented as write-to-temp + rename; a leaked temp file
    // would mean a crash mid-write could leave a half-written blob at the
    // final path, which under content addressing looks indistinguishable
    // from a good one.
    const store = tmpStore();
    const ref = store.put('atomic body');
    const dir = join(store.root, ref.slice(0, 2));
    const entries = readdirSync(dir);
    expect(entries.every((name) => !name.startsWith('.tmp-'))).toBe(true);
  });
});

describe('round-trip', () => {
  it('round-trips a Uint8Array through put/get byte-for-byte', () => {
    const store = tmpStore();
    const bytes = new Uint8Array([0, 1, 2, 255, 254, 10, 13]);
    const ref = store.put(bytes);
    expect(Array.from(store.get(ref))).toEqual(Array.from(bytes));
  });

  it('round-trips a string through put/getText', () => {
    const store = tmpStore();
    const text = 'diff hunk with unicode: café ★ 日本語';
    const ref = store.put(text);
    expect(store.getText(ref)).toBe(text);
  });
});

describe('getTextPrefix — §9 context_peek', () => {
  it('reads no more than maxBytes even when the blob is much larger', () => {
    const store = tmpStore();
    const body = 'x'.repeat(10_000);
    const ref = store.put(body);
    const prefix = store.getTextPrefix(ref, 100);
    expect(Buffer.byteLength(prefix, 'utf8')).toBeLessThanOrEqual(100);
    expect(prefix).toBe('x'.repeat(100));
  });

  it('returns the whole blob as valid text when it is smaller than maxBytes', () => {
    const store = tmpStore();
    const ref = store.put('short');
    expect(store.getTextPrefix(ref, 4_096)).toBe('short');
  });

  it('throws BlobMissingError rather than reading a nonexistent file', () => {
    const store = tmpStore();
    const fakeRef = sha256('never stored');
    expect(() => store.getTextPrefix(fakeRef, 10)).toThrow(BlobMissingError);
  });
});

describe('missing blobs fail loud (plan Rule: fail loud)', () => {
  it('get() throws BlobMissingError instead of returning empty content', () => {
    // A missing blob means a derived layer (L1 span, L0 event) references
    // content that was never durably written to L2 — silently returning an
    // empty buffer would hide that as if the referenced content were valid
    // and empty, corrupting whatever reads it next.
    const store = tmpStore();
    const fakeRef = sha256('never stored');
    expect(() => store.get(fakeRef)).toThrow(BlobMissingError);
  });

  it('getText() throws BlobMissingError instead of returning an empty string', () => {
    const store = tmpStore();
    const fakeRef = sha256('never stored');
    expect(() => store.getText(fakeRef)).toThrow(BlobMissingError);
  });

  it('size() throws BlobMissingError instead of returning 0', () => {
    const store = tmpStore();
    const fakeRef = sha256('never stored');
    expect(() => store.size(fakeRef)).toThrow(BlobMissingError);
  });

  it('has() returns false for an absent ref without throwing', () => {
    const store = tmpStore();
    expect(store.has(sha256('never stored'))).toBe(false);
  });
});

describe('ref validation', () => {
  it('rejects a traversal-shaped ref rather than building a path from it', () => {
    // pathFor is used to open files; accepting "../../etc/passwd"-shaped
    // input would let a bad ref (wherever it originated — a corrupted L1
    // row, an attacker-controlled string) escape the blobs root entirely.
    const store = tmpStore();
    expect(() => store.pathFor('../../etc/passwd')).toThrow();
  });

  it('rejects a ref with the wrong length or non-hex characters', () => {
    const store = tmpStore();
    expect(() => store.pathFor('deadbeef')).toThrow();
    expect(() => store.pathFor('g'.repeat(64))).toThrow();
    expect(() => store.pathFor('A'.repeat(64))).toThrow(); // uppercase not accepted
  });

  it('has() rejects a bad ref rather than silently reporting it absent', () => {
    const store = tmpStore();
    expect(() => store.has('../../etc/passwd')).toThrow();
  });
});

describe('size', () => {
  it('reports the exact byte length of stored content', () => {
    const store = tmpStore();
    const ref = store.put('12345');
    expect(store.size(ref)).toBe(5);
  });
});
