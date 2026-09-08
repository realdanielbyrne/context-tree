/** Observations for opt-in H4 experiments. A phrase never grants permission or
 * establishes that any history is irrelevant. No model call or learned rule. */
export type AttentionSignalKind = 'sufficiency' | 'research_done' | 'topic_shift';

export interface AttentionSignal {
  kind: AttentionSignalKind;
  sourceSeq: number;
  phrase: string;
  start: number;
  end: number;
}

/** Ignore quoted examples, code, and negated statements rather than treating
 * their words as the assistant's own current intent. Offsets refer to L0 text. */
export function detectAttentionSignals(text: string, sourceSeq: number): AttentionSignal[] {
  const mask = (value: string): string => value.replace(/[^\n]/g, ' ');
  const visible = text
    .replace(/```[\s\S]*?(?:```|$)/g, mask)
    .replace(/`[^`\n]*`/g, mask)
    .replace(/^\s*>.*$/gm, mask)
    .replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’/g, mask)
    .replace(/(^|\s)'[^'\n]*'(?=\s|[.,!?]|$)/g, mask);
  const patterns: readonly [AttentionSignalKind, RegExp][] = [
    ['sufficiency', /\bI have (?:enough|sufficient) (?:information|context|evidence)\b[^.!?\n]*/gi],
    ['research_done', /\bshould I implement (?:the |this )?plan\b/gi],
    ['research_done', /\b(?:research is complete|I am ready to implement)\b/gi],
    ['topic_shift', /\bnow (?:let['’]s|we (?:can|will)) (?:look at|work on|move to)\b[^.!?\n]*/gi],
  ];
  const signals: AttentionSignal[] = [];
  for (const [kind, pattern] of patterns) {
    for (const match of visible.matchAll(pattern)) {
      const start = match.index;
      const prior = visible.slice(0, start);
      const boundary = Math.max(prior.lastIndexOf('.'), prior.lastIndexOf('!'), prior.lastIndexOf('?'), prior.lastIndexOf('\n'));
      const clause = visible.slice(boundary + 1, start + match[0].length);
      if (/\b(?:not|never|cannot|can't|don['’]t|doesn['’]t|isn['’]t|wouldn['’]t|shouldn['’]t|no longer|if|whether|but|however|still need)\b/i.test(clause)) continue;
      signals.push({ kind, sourceSeq, phrase: text.slice(start, start + match[0].length), start, end: start + match[0].length });
    }
  }
  return signals.sort((a, b) => a.start - b.start || a.kind.localeCompare(b.kind));
}
