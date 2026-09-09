# Recorded completions (§17)

> **These cassettes are hand-authored, not recorded.** No API key was available
> when they were written, so the replies in them were composed by hand to match
> the §8 content contract. Every cassette says so in its own `_provenance`
> entry, and `packages/core/test/live/contract.test.ts` fails if that entry is
> removed. Nothing here is evidence of how a real model behaves — that claim
> belongs to `live.test.ts`, and only when someone runs it with a key.

§17 splits the model-facing test story in two: **prompts tested against
recorded completions (no network in CI)**, and a **`LIVE=1` opt-in suite** that
hits real models. This directory is the first half.

| File | What it holds |
|---|---|
| `leaf-summary.v1.json` | one reply per golden branch for the `leaf-summary.v1` prompt (5 branches) |
| `root-summary.v1.json` | one reply for the `root-summary.v1` prompt |

The `v1` in each filename is the prompt version it was produced from
(`LEAF_SUMMARY_VERSION` / `ROOT_SUMMARY_VERSION`). A `v2` template is a
different prompt and gets its own file rather than silently replacing this one.

## Why a hand-written cassette needs a marker

A cassette is trusted precisely because it is supposed to be a transcript. A
fabricated reply filed under that name is worse than no cassette at all: it
becomes the thing everyone points at when they ask "what does the model
actually return?", and the answer is "whatever the person who wrote the JSON
imagined". The marker is what keeps that from happening quietly.

## File format

`RecordedProvider` keys a cassette by `requestKey(request)` — a SHA-256 over the
model id, the system block, the messages and the `json` flag — so every
replayable entry is a 64-character hex key. Three reserved keys are not:

| Key | Purpose |
|---|---|
| `_provenance` | hand-authored vs. recorded, and when |
| `_regenerate` | the exact command that rewrites this file |
| `_malformed_*` | a deliberately contract-violating reply, for the failure path |

They are still shaped like a `CompletionResult` (`text` / `model` / `usage` /
`toolCalls` / `stopReason`), because `readCassette` parses every top-level value
as one and a bare string would make the whole file unloadable. `model` is
`"none"` on the two markers: no model produced them. An underscore-prefixed key
can never collide with a hex digest, so none of the three is ever replayed.

The `_malformed_*` entry stays hand-authored even after a real re-record. It is
a fixture for the §8 contract-violation path, not something a model was asked to
produce.

## Regenerating

Run from the repo root. `vite-node` is what resolves the `@context-tree/*`
aliases, and its bin is not linked at the root, hence the `$VN` dance:

```bash
VN=$(node -e "process.stdout.write(require.resolve('vite-node/vite-node.mjs',{paths:[require.resolve('vitest/package.json')]}))")

# hand-authored replies from packages/core/test/live/golden.ts — no key, no network
node "$VN" --config vitest.config.ts packages/core/test/live/record.ts -- --authored

# real completions, which replaces the hand-authored replies and restamps _provenance
LIVE=1 ANTHROPIC_API_KEY=sk-... \
  node "$VN" --config vitest.config.ts packages/core/test/live/record.ts -- --live

# OpenRouter instead
LIVE=1 CONTEXT_TREE_PROVIDER=openrouter OPENROUTER_API_KEY=sk-... \
  node "$VN" --config vitest.config.ts packages/core/test/live/record.ts -- --live
```

Either mode runs the real `Summarizer` over the five golden branches in
`packages/core/test/live/golden.ts` and lets `RecordingProvider` key what was
actually sent. That is not ceremony: the keys are content hashes of the prompt,
so hand-editing this JSON means hand-computing SHA-256.

**Edit a summary prompt and these files go stale.** The key changes, replay
misses, and `contract.test.ts` says so by name — re-record, don't patch the
hash.

## The golden branches are synthetic

The five branches are a hand-written trace of a fictional fix to a fictional
`acme/notes-api` pagination cursor. §17 suggests scrubbed real Claude Code
sessions for `eval/fixtures/`; these cassettes deliberately do not use one. A
trace log is a verbatim record of somebody's work, and scrubbing it is never
provably complete.
