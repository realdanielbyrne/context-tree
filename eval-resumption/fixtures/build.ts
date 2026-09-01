/**
 * The fixture builder (§17 "golden fixtures", §15 "full trace log" per task).
 *
 * EVERY FIXTURE IN THIS DIRECTORY IS SYNTHETIC. Nothing here is derived from a
 * real Claude Code transcript: a trace log is a verbatim record of someone's
 * private work and scrubbing is never provably complete. §17 says "recorded
 * traces (real sessions, scrubbed)"; this is a deliberate, stated deviation
 * from that line and from nothing else in §17.
 *
 * A task declares a session SHAPE — "diagnosis, then three file edits, then a
 * failing test run, then a fix, then a PR" — and gets a valid `TaskEvent[]`
 * back. The harness's `materializeTrace` turns that into L0 + L2, so the
 * fixture exercises the real hermetic ingestion path (§7.1) rather than a
 * parallel one.
 *
 * Determinism is a hard requirement, not a nicety (D1/D8): no clock, no
 * randomness, no `Date.now`, no counters that depend on call order across
 * builders. Two generations of a fixture must be byte-identical or `rebuild()`
 * stops being a function of L0 + L2.
 */
import type { PhaseType } from '@context-tree/core';
import type { TaskEvent } from '../harness/task-spec.js';

/**
 * Fluent trace builder. Every method appends the events one recorded turn
 * produces (a `tool_call` and its `tool_result` travel together, because a call
 * with no result is a shape ingestion never sees in a finished session).
 *
 * Tool names are the §7 `TOOL_PHASE` defaults from core's config, so the phase
 * a method lands in is stated in its doc comment and asserted in the tests —
 * a builder whose `verify()` silently produced an `implementation` phase would
 * make every task's phase assumption a lie.
 */
export class TraceBuilder {
  private readonly out: TaskEvent[] = [];

  /** A human turn. Attaches to the open phase; never opens one (§7). */
  user(text: string): this {
    this.out.push({ type: 'user_message', text });
    return this;
  }

  /** An agent turn — where a decision is stated, and so where a buried fact lives. */
  say(text: string): this {
    this.out.push({ type: 'assistant_message', text });
    return this;
  }

  /** `Read` -> `diagnosis`. */
  read(path: string, output: string): this {
    return this.call('Read', { path, args: { path } }, output);
  }

  /** `Grep` -> `diagnosis`. */
  grep(pattern: string, output: string): this {
    return this.call('Grep', { args: { pattern } }, output);
  }

  /**
   * `Edit` -> `implementation`, and a FILE NODE keyed by `path` under that
   * phase. `content` is the post-edit file, which is what §12 parses for spans.
   */
  edit(path: string, content: string): this {
    return this.call('Edit', { path, content, args: { path } }, `edited ${path}`);
  }

  /** `Write` -> `implementation`, same file-node keying as `edit`. */
  write(path: string, content: string): this {
    return this.call('Write', { path, content, args: { path } }, `wrote ${path}`);
  }

  /** `run_tests` -> `verification`. */
  verify(suite: string, output: string): this {
    return this.call('run_tests', { args: { suite } }, output);
  }

  /**
   * `run_tests` -> `verification`, with the result carrying `error`. The
   * failing run is the event a resumed task is usually interrupted on, so it
   * has to be expressible without inventing a sixth event type.
   */
  verifyFails(suite: string, output: string, error: string): this {
    this.pushCall('run_tests', { args: { suite } });
    this.out.push({ type: 'tool_result', output, error });
    return this;
  }

  /**
   * `Bash` -> `other`, which is NEUTRAL by default (Ruling C6): it extends the
   * open phase instead of opening one. This is the method that makes the
   * read-dominated shape produce one diagnosis branch rather than eleven.
   */
  shell(command: string, output: string): this {
    return this.call('Bash', { args: { command } }, output);
  }

  /** `open_pr` -> `delivery`. */
  openPr(ref: string, title: string): this {
    return this.call('open_pr', { args: { ref, title } }, `opened ${ref}: ${title}`);
  }

  /** `post_comment` -> `review`. */
  comment(ref: string, text: string): this {
    return this.call('post_comment', { args: { ref, text } }, `commented on ${ref}`);
  }

  /**
   * A tool name with no `TOOL_PHASE` mapping. §18 requires this to degrade to
   * `other`, never to crash, so a fixture has to be able to produce one.
   */
  unmapped(tool: string, args: Record<string, unknown>, output: string): this {
    return this.call(tool, { args }, output);
  }

  /** An explicit host-declared phase boundary — honoured over the state machine (§7). */
  boundary(to: PhaseType, from?: PhaseType): this {
    this.out.push(from === undefined ? { type: 'segment_boundary', to } : { type: 'segment_boundary', to, from });
    return this;
  }

  /** The event list, copied — a builder must not hand out its own mutable array. */
  events(): TaskEvent[] {
    return this.out.map((event) => ({ ...event }) as TaskEvent);
  }

  private pushCall(
    tool: string,
    parts: { path?: string; content?: string; args?: Record<string, unknown> },
  ): void {
    const call: TaskEvent = { type: 'tool_call', tool };
    if (parts.path !== undefined) call.path = parts.path;
    if (parts.content !== undefined) call.content = parts.content;
    // JSON.stringify of an object literal is key-ordered by construction, so
    // the serialized args are stable across generations.
    if (parts.args !== undefined) call.args = JSON.stringify(parts.args);
    this.out.push(call);
  }

  private call(
    tool: string,
    parts: { path?: string; content?: string; args?: Record<string, unknown> },
    output: string,
  ): this {
    this.pushCall(tool, parts);
    this.out.push({ type: 'tool_result', output });
    return this;
  }
}

export function buildTrace(): TraceBuilder {
  return new TraceBuilder();
}

/**
 * Canonical JSON for one event: fixed key order per type, so a regeneration is
 * byte-identical regardless of how the builder happened to assemble the object.
 * `JSON.stringify` follows insertion order, which is exactly the property a
 * hand-written builder must not be trusted to preserve.
 */
function serializeEvent(event: TaskEvent): string {
  switch (event.type) {
    case 'user_message':
    case 'assistant_message':
      return JSON.stringify({ type: event.type, text: event.text });
    case 'tool_call': {
      const out: Record<string, unknown> = { type: 'tool_call', tool: event.tool };
      if (event.path !== undefined) out.path = event.path;
      if (event.args !== undefined) out.args = event.args;
      if (event.content !== undefined) out.content = event.content;
      return JSON.stringify(out);
    }
    case 'tool_result': {
      const out: Record<string, unknown> = { type: 'tool_result' };
      if (event.call !== undefined) out.call = event.call;
      if (event.output !== undefined) out.output = event.output;
      if (event.error !== undefined) out.error = event.error;
      if (event.truncated !== undefined) out.truncated = event.truncated;
      return JSON.stringify(out);
    }
    case 'segment_boundary': {
      const out: Record<string, unknown> = { type: 'segment_boundary' };
      if (event.from !== undefined) out.from = event.from;
      out.to = event.to;
      return JSON.stringify(out);
    }
    default:
      // The union is closed; an unknown type is a spec change, and a fixture
      // that silently dropped an event would be a benchmark grading less than
      // it claims to.
      throw new Error(`serializeEvent: unknown event type ${JSON.stringify((event as { type: string }).type)}`);
  }
}

/**
 * `.jsonl` text for a fixture: `//` header lines (which `loadFixtureEvents`
 * skips) then one event per line.
 *
 * The header is not decoration. Every fixture file has to say, in the file
 * itself, that it is synthetic and what shape of session it imitates, because
 * the file will outlive this directory's README.
 */
export function serializeTrace(header: readonly string[], events: readonly TaskEvent[]): string {
  const lines = [
    '// SYNTHETIC FIXTURE — generated by eval/fixtures/generate.ts, never derived',
    '// from a real transcript. Regenerate with:',
    '//   npx vitest run eval/tasks/tasks.test.ts   (asserts these bytes)',
    ...header.map((line) => `// ${line}`),
    ...events.map(serializeEvent),
  ];
  return `${lines.join('\n')}\n`;
}
