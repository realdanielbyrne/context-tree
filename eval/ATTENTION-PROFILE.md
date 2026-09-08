The `attention` arm requires an explicit version 1 policy profile. It preserves
original task, assistant, tool input and producer response bytes in L0/L2. Tool
messages retain the full call ID, name and arguments before the selected output.
The physical model window is the only occupancy constraint; occupancy is logged,
and does not trigger filling or eviction.

```json
{"version":1,"id":"declared-experiment","payload":{"mode":"whole","excerptChars":1000,"anchor":"first","producers":["context","read_file"]}}
```

This example declares an experimental whole-payload arm; it is not a recommended
default. `excerptChars` is the explicit control envelope, including when a whole
payload arm compares search admission. Structural payloads without a verified
partition fall back to unchanged producer output with an unsupported status.
`producers` defaults to `["context"]`; commands and edits never undergo payload
selection. All modes expose the same tool schemas. Original, admission-view,
selected-payload and delivered-message blobs remain distinct audit coordinates.
Selection is acknowledged only after the next successful model call.

Optional `attention` switches are `excludeIrrelevant`, `pinPlan`, `recency`
(`exchange`, `subtask`, `all`), `sufficiencyGate`, `topicShiftReset`,
`demandExpansion`, `priority` and `breadth`. Priority requires explicit `boost`,
`halfLifeTurns` and `calibrationId`; breadth requires `relevanceMass` in `(0,1]`
and `calibrationId`. A calibration identifier records provenance; it does not
establish that calibration is valid. Change one candidate variable per comparison.

The optional declaration convention uses the existing annotation text or a
user-message L0 artifact. It introduces no tool or model call:

```json
{"attention_v1":{"kind":"plan","source_seq":2}}
{"attention_v1":{"kind":"subtask","id":"ui","state":"begin"}}
{"attention_v1":{"kind":"relevance","unit_seqs":[3],"scope_seq":5,"evidence_seqs":[1],"value":"irrelevant"}}
```

Each line is a separate complete JSON artifact. A plan declaration must refer to
an earlier assistant/user artifact; arbitrary filenames, prose and tool output
do not establish a plan. Subtask declarations provide exact boundaries; ordinary
topic-shift language does not. Relevance coordinates must exist earlier in L0.
Negative relevance requires a user-message declaration, is valid only in the
explicitly named current subtask, and expires at the next declared boundary.
Model-authored annotations cannot establish negative relevance. Query recurrence
and task/plan/steering protection override scoped exclusion. Unknown relevance
is retained. The harness does not solicit declarations to activate mechanisms;
without supplied declarations these gates remain inactive.

Successful edits map to earlier exact-path sources. Fetch priority maps only
acknowledged selected payloads whose returned spans and complete source bytes
establish exposure; truncated or unsupported views cannot claim unseen sources.
Supersession removes the old source's priority boost without deleting its history.
The latest assistant's sufficiency/research-done/topic-shift phrases are source
observations, never permission or negative relevance. Explicit tool demand remains
eligible after a sufficiency observation; this arm has no automatic exploratory
fetches to suppress.

H2 and H5 operate on actual returned `context_search.hits`, with the original
producer response retained. Positive finite scores with unique existing L0
sequence coordinates form the measured pool; duplicate, unknown, external and
unmapped hits remain unchanged. H2 selects cumulative relevance mass within the
configured excerpt's measured token envelope, after fixed response metadata and
unknown hits. H5 alone allows that envelope to expand into actual physical request
headroom. `demandExpansion:false` explicitly selects the fixed-envelope control;
omitting breadth, priority and demand expansion leaves admission unchanged.
Priority changes ranking inside the same envelope. The pool is bounded by the
upstream search producer; this is not a full-index relevance-mass estimate.

`attention_turn` records source-evidence counts and actual history/ledger effects.
`attention_admission` records the candidate pool, envelope, normalized scores,
priority and dispositions. `attention_payload` records separate payload effects,
fallback and producer truncation; `attention_delivery` records actual exposure.
Missing labels, missing declarations and absent tool demands are inactive gates,
not passed experiments or evidence of equivalence. Synthetic tests verify these
mechanisms and source-prefix invariants; live quality and calibrated defaults
still require the preregistered balanced comparisons.
