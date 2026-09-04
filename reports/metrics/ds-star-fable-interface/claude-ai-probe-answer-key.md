# claude.ai chat-search probe — answer key (user's own chat, used with permission)

Test transcript: the user's claude.ai chat "Pricing G.Skill DDR5 RAM for marketplace"
(id 41188054-f8a9-4c1a-bcc2-0ceea84702df, 4 user turns, 4 assistant turns, ~5 days old at
probe time, 2026-09-04). Read in full via the browser before any probe, so the keys below
are ground truth, not recollection. Literals chosen the way the transplant harness chooses
them: exact strings a fluent model cannot synthesize without reading the turn.

| id | question (asked verbatim in a fresh chat) | answer literal | where in chat |
|---|---|---|---|
| p1 | In my past chat about pricing G.Skill DDR5 RAM for marketplace, what was the exact model number of the RAM kit? | `F5-5600S4040A16GX2-RS` | turn 1 (assistant), early |
| p2 | In my past chat about pricing G.Skill DDR5 RAM, what list price did I say the Newegg link showed? | `$489` | turn 3 (user), middle |
| p3 | In my chat about pricing G.Skill DDR5 RAM, what did Claude say caused the wrong high price to appear on the Newegg page? | `WD_BLACK` (sponsored SSD ad rendering above the listing) | turn 3 (assistant), middle |
| p4 | In my past chat about pricing G.Skill DDR5 RAM, what was the cheapest price I said I found, and at which store? | `$300`, Walmart | turn 4 (user), late |
| p5 | In my past chat about pricing G.Skill DDR5 RAM for marketplace, what final listing price did Claude recommend at the end? | `$260` | turn 4 (assistant), last |

Scoring mirrors the harness: (a) was the literal present in any snippet returned by
`conversation_search`; (b) was `read_conversation` called, and was the literal present in
the returned page; (c) did the final answer contain the literal. Also record per probe: hits
returned, snippet lengths (chars), whether hits carry `page_token`, `kind`, and how many turns a
read returned.

## Probe log (claude.ai web, Sonnet 5 "Medium", 2026-09-04 ~09:15-09:30 CDT)

Method: each probe is a fresh claude.ai chat driven through the Claude-in-Chrome extension. The
UI renders search only as a "Relevant chats" chip; the raw `<chat>` payload is not in the DOM and
the model declines to paste it verbatim ("includes internal fields like page_tokens that aren't
meant for display"). So per-hit structure below is the model's own description of its tool
result, obtained with a follow-up question in the same chat — SELF-REPORTED, not observed bytes.
Word counts are the model's estimates. Final answers and the chip are observed.

### p1 — model number (early turn). Chat 3e1cc199-d826-41b9-8dad-6f7ba5787352
- Final answer: **correct** (`F5-5600S4040A16GX2-RS`), first turn, no read_conversation call.
- Query sent: `G.Skill DDR5 RAM marketplace pricing` (content nouns, as the contract instructs).
- Hits: 5. Kinds: 2 summary + 3 conversation. 3 of 5 from the target chat, 2 unrelated.
  | rank | kind | chat | page_token | ~words | covers | literal in snippet |
  |---|---|---|---|---|---|---|
  | 1 | summary | target | none | ~190 | whole-chat digest | yes |
  | 2 | conversation | target | present | ~230 | Human turn 1 → Assistant turn 1, cut at start of Human turn 2 | yes |
  | 3 | conversation | unrelated (Hall of Fame photos) | present | ~25 | one Human turn | no |
  | 4 | conversation | target | present | ~360 | mid-Assistant turn 2 → Human $489 → Human $300 → Assistant correction | yes |
  | 5 | summary | unrelated (recent highlights) | none | ~190 | multi-topic digest | no |
- Payload ≈ 1,000 words of snippet ≈ 1.3-1.5k tokens for 5 hits WITH content. Our compact 20-hit
  coordinate list costs 1.2-1.4k tokens with NO content.
- Retrieval unit = a contiguous multi-turn chunk of ~230-360 words that can start/stop mid-turn;
  the same chat surfaces as several chunks. Summaries are a second index over whole chats and
  DO carry identifiers (the model number appeared in the summary hit).

### p2 — Newegg list price (middle, user turn). Chat e001d4c4-9108-44ff-a728-0b3f8096494e
- Final answer: **correct** (`$489`), first turn, 1 search call, no read_conversation.
- Query sent: `G.Skill DDR5 RAM Newegg price`.
- Hits: 5 (1 summary + 4 conversation); 3 from target chat, 2 unrelated (both Hall of Fame chats).
  | rank | kind | chat | page_token | ~words | covers | `$489` in snippet |
  |---|---|---|---|---|---|---|
  | 1 | summary | target | none | ~180 | whole-chat abstract, no dollar figures | no |
  | 2 | conversation | target | present | ~230 | turn 1 → start of turn 2 | no |
  | 3 | conversation | unrelated | present | ~140 | photo-search suggestions | no |
  | 4 | conversation | target | present | ~220 | "You should do a real internet search..." → revised $260 listing | **yes** (twice, in the assistant's correction) |
  | 5 | conversation | unrelated | present | ~30 | opening turn | no |
- The user's own turn stating "$489" was NOT in any snippet; the literal arrived via the
  assistant's later restatement. Correct answer, but delivered by a different event than the
  answer key's source — the harness's "delivered literal" metric would still count it.
- Chunk boundaries differ from p1 for the same chat (p1 rank 4 ≈ 360 words starting mid
  assistant turn 2; here rank 4 ≈ 220 words starting at user turn 4). Either chunks are
  query-dependent windows or the self-reported spans are imprecise — cannot distinguish from
  the UI.

### p3 — cause of the wrong high price (middle, assistant turn). Chat 09dcdb93-9ecc-4276-9151-d5a7a07cbc70
- Final answer: **exact-match FAIL, gist partially right.** Answered "dismissed it as a page
  rendering error" (correct gist) but never named the `WD_BLACK` sponsored-SSD-ad explanation
  the answer key requires, then pivoted to the later DRAM-surge explanation. Under the
  transplant harness's literal grading this scores 0. No read_conversation call (see follow-up).
- Query sent: `G.Skill DDR5 RAM Newegg price` (identical to p2). 1 search, 0 reads.
- Hits: 5 (1 summary + 4 conversation); target chat at ranks 1, 2, 4. `WD_BLACK` in NO snippet.
  Ranks 2 and 4 cover the chat's opening (turn 1 → start of turn 2) and its ending (turn 4 →
  final listing). The answer-bearing middle (assistant turn 3, the WD_BLACK explanation) was in
  no returned chunk. The rank-1 summary paraphrased it as a "page rendering error".
- Model's own account: it answered from the summary "without opening the raw transcript to
  confirm the exact original wording". This is the failure our passes documented on our own
  system — a summary can say something happened but not what it said (contract rule 2), and
  the model did not spend a read to get the literal. Anthropic's interface does not prevent it.

### p4 — cheapest price and store (late, user turn). Chat f7a07d87-364f-4c89-ba66-3d2ebfe7de5f
- Final answer: **correct** (`$300`, Walmart), first turn. Query chip: `G.Skill DDR5 RAM price`.
- 1 search, 0 reads. 5 hits (1 summary + 4 conversation); target at ranks 1, 2, 4; ranks 3, 5
  unrelated (Teams meeting limits, Hall of Fame). Rank 4's chunk contained the human turn with
  `$300` and `Walmart` verbatim.

### p5 — final recommended listing price (last assistant turn). Chat ace8010c-9464-498a-9110-0bc5cab7e6fe
- Final answer: **correct** (`$260 OBO`), first turn. Query chip: `G.Skill DDR5 RAM pricing marketplace`.
  Structure follow-up skipped (pattern stable across p1-p4).

### Score after p1-p5: 4/5 exact-match, 5/5 searches answered in one turn with one search call
and zero read_conversation calls. The single miss (p3) was a summary-paraphrase answer where the
answer-bearing chunk was not among the 5 hits and the model did not read.

### r1 — forced read: "open the chat at the point where ... and quote the exact sentence". Chat 1ca86eab-5ada-4e41-bda9-e348afa21d32
- Final answer: **correct**, verbatim quote containing `WD_BLACK` ("...pulling in the price
  from the sponsored WD_BLACK SSD ad shown above it on that page..."). The UI chip read
  "Searched memory" rather than "Relevant chats". Same fact p3 missed when asked as a plain
  question; the phrasing that asks to OPEN the chat retrieved it.
- Tool calls (self-reported): TWO `conversation_search` calls, ZERO `read_conversation`.
  1. `conversation_search(query="G.Skill DDR5 RAM Newegg price")` → 5 hits (1 summary + 4
     conversation), ~800 words payload. Same query as p2/p3, so the same miss: WD_BLACK absent.
  2. `conversation_search(query="Newegg page rendering error wrong price",
     within_conversation_id="41188054-...")` → 3 hits, all conversation chunks, ~550 words. The
     first block ("For the actual kit in your photo..." incl. "H: The link you referenced has a
     list price of $489") carried the WD_BLACK sentence.
- So the second hop that recovered the literal was a SCOPED SEARCH inside the selected chat with
  a reformulated query — not a page read. Snippets carry the payload; the "read" affordance went
  unused in 6 of 6 chats so far. In our terms: the second-stage unit is still a ~200-word chunk,
  selected by a new query, and the model reformulates using words from the summary it already
  saw ("rendering error").

### r2 — read_conversation named explicitly. Chat c1dd6b6c-cd36-4219-aed1-7e2f922fe12c
- UI chip: "Searched memory, used a tool". Self-reported page: **6 turns (turns 2-7 of an
  8-turn chat), ~650 words**, `prev_page_token` present, no `next_page_token`; opened AT the
  matching turn (anchor turn 6, the user's "$300 on Walmart") with the lead-in turns before it
  and the assistant's reply after it. With `max_turns` at its default of 20 the page was the
  whole chat minus its first turn — on a short chat the read is effectively "the chat".
- Self-report is internally inconsistent (turns 2-7 of 8 yet "ran to the end"); treat the turn
  numbers as approximate.

## What the probes establish (observed vs self-reported marked)

1. **Observed.** 4/5 plain questions answered correctly in one turn; the failure (p3) required a
   literal that lived in an assistant turn no returned chunk covered, and the model answered from
   the summary's paraphrase. Asking to "open the chat at the point where..." recovered it (r1).
2. **Self-reported, consistent across 7 chats.** `conversation_search` returns exactly 5 hits;
   1-2 are `summary` (whole-chat digests, ~180-230 words, no page_token, DO carry identifiers
   such as the model number) and 3-4 are `conversation` chunks (~25-360 words, mostly 200-300;
   contiguous multi-turn spans that can start and stop mid-turn; page_token each). The same
   chat appears as several chunks. Total payload ≈ 800-1,000 words ≈ 1.1-1.4k tokens.
3. **Self-reported.** The model's second hop, when it took one, was
   `conversation_search(query', within_conversation_id=...)` — a scoped re-search with a
   reformulated query (r1: 3 chunks, ~550 words) — not a page read. `read_conversation` was
   called only when named explicitly (r2), and returned ~650 words / 6 turns opened at the hit.
4. **Comparison to our arms at equal payload.** Our compact 20-hit coordinate list costs
   1.2-1.4k tokens and carries NO content; Anthropic's 5-hit list costs about the same and
   carries ~800 words of raw transcript, so 4 of 5 questions were answered without any fetch.
   Our system needs search + fetch (two turns, and the fetch is a token-band of a whole branch);
   theirs needs one turn for most questions because the retrieval UNIT is a ~250-word chunk and
   the hit IS the payload. This is rule 6 (size the unit first) and rule 7 (a coordinate is not a
   payload) answered by construction.
5. **Limits of this probe.** Sonnet 5 Medium in claude.ai, one 8-turn chat, 5 questions, n=1
   each, self-reported internals, a corpus of ~25 chats (no distractor pressure comparable to a
   754-event trace). Nothing here measures their ranking at our scale.
