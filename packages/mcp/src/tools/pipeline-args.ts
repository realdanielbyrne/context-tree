/** Arguments the pipeline stages share. Stage parameters come from the registry (`params.ts`), not from here. */
import { z } from 'zod';

export const turnArg = z
  .number()
  .int()
  .nonnegative()
  .optional()
  .describe("The host's turn number. Moves the session clock forward; omit to use the current one.");

export const windowShape = {
  window_tokens: z
    .number()
    .positive()
    .describe('The limit, in HEURISTIC tokens (core HeuristicTokenizer over unit text) — not the served tokenizer.'),
  reserve_tokens: z
    .number()
    .nonnegative()
    .optional()
    .describe('Held back from the window: the reply, and whatever the caller cannot see (system block, tool schemas). Default 0.'),
};

export const messagesArg = z
  .array(z.object({ id: z.string().min(1), hasTools: z.boolean().optional() }).loose())
  .min(1)
  .optional()
  .describe("For a host plugin: the host's messages, in order. The result then carries one decision per message.");

export const budgetOf = (args: { window_tokens: number; reserve_tokens?: number | undefined }): number | null => {
  const budget = args.window_tokens - (args.reserve_tokens ?? 0);
  return budget > 0 ? budget : null;
};
