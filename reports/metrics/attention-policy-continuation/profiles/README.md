# Explicit research profiles

These files are experimental inputs to `--arms attention --policy-profile FILE`.
They do not change product defaults. All name the same producer boundary:
serialized context-tool responses and `read_file` responses. Command/edit outputs
use the same existing contract in every arm. Originals are retained separately.

- `whole`: exact producer output; the comparison control, not a preservation rule.
- `excerpt`: first anchored 1,000-character band, the existing library excerpt size.
- `excerpt-rarest`: same size, within-response rarest query term. With no query terms
  (ordinary file reads), both anchors are inert and must not earn a ranking win.
- `structural`: requires a supported parser and explicit section relevance; current
  live producers lack that evidence, so the mechanism gate rejects a live batch.
- `ledger`: whole producer output plus an L0-derived record of executed actions and
  outcomes. No inferred completion claims or compression of previous history.

The physical request window is supplied separately. No fraction of it is a target.
Only mechanism-qualified profiles receive equal n=5 public-SWE comparisons; one
registered n=10 escalation can resolve ambiguity. Profile presence is not evidence
that it passed those checks. H1–H6 and priority parameters stay in the core opt-in
API until their prefix data and calibration gates can be satisfied.
