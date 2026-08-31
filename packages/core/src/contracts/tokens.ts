/**
 * Deterministic token accounting (Ruling C8). Required by §10's zone budgets
 * and by §17's cache-assertion harness, which must be reproducible offline.
 */
export interface Tokenizer {
  /** Stable id recorded in cache assertions so a tokenizer swap is visible. */
  readonly id: string;
  count(text: string): number;
}
