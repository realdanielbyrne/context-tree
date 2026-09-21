/**
 * opencode session export -> L0 events + L2 blobs.
 *
 * Input is the JSON document `opencode export <sessionID>` writes to stdout.
 * The schema comes from `packages/schema/src/v1/session.ts` in the opencode
 * repo (published as generated SDK types); the prose docs do not specify it.
 *
 * Maps tolerantly: unknown part types increment `skipped`, malformed messages
 * become per-message `failures`. Reuses the `LineFailure`/`TranscriptResult`
 * shape so `importCommand`'s reporting is unchanged.
 */
import type {
  AssistantMessageEvent,
  ToolCallEvent,
  ToolResultEvent,
  TraceEventInput,
  UserMessageEvent,
} from '@context-tree/core';
import type { LineFailure, TranscriptResult, TranscriptOptions } from './claude-code.js';

const EPOCH = '1970-01-01T00:00:00.000Z';
const ERROR_DETAIL_CHARS = 200;
/** L0 keeps the head of the command for phasing (D21); the full args stay in `args_blob`. */
const COMMAND_CHARS = 512;

export function mapOpencodeExport(
  doc: unknown,
  options: TranscriptOptions,
): TranscriptResult {
  const events: TraceEventInput[] = [];
  const failures: LineFailure[] = [];
  let skipped = 0;
  let blobsWritten = 0;

  const nextSeq = (): number => options.startSeq + events.length + 1;
  const put = (content: string): string => {
    const ref = options.blobs.digest(content);
    if (!options.blobs.has(ref)) blobsWritten += 1;
    return options.blobs.put(content);
  };

  if (!isRecord(doc)) {
    failures.push({ line: 1, error: 'expected a JSON object at top level' });
    return { events, failures, skipped, blobsWritten };
  }

  const messages = doc.messages;
  if (!Array.isArray(messages)) {
    failures.push({ line: 1, error: 'expected "messages" array' });
    return { events, failures, skipped, blobsWritten };
  }

  for (let i = 0; i < messages.length; i += 1) {
    const msgIndex = i + 1;
    const msg = messages[i] as unknown;
    if (!isRecord(msg)) {
      failures.push({ line: msgIndex, error: 'message is not an object' });
      continue;
    }

    const info = msg.info;
    if (!isRecord(info)) {
      failures.push({ line: msgIndex, error: 'message has no "info" object' });
      continue;
    }

    const role = info.role;
    if (role !== 'user' && role !== 'assistant') {
      skipped += 1;
      continue;
    }

    const ts = epochMsToIso(info.time, msg.time);
    // One opencode message is one turn; its id is the only boundary a text-less message leaves.
    const turn = typeof info.id === 'string' && info.id.length > 0 ? { turn_id: info.id } : {};

    const parts = msg.parts;
    if (!Array.isArray(parts)) {
      failures.push({ line: msgIndex, error: `${role} message has no "parts" array` });
      continue;
    }

    const textParts: string[] = [];
    const toolParts: Array<Record<string, unknown>> = [];

    for (const part of parts as unknown[]) {
      if (!isRecord(part)) continue;
      const type = part.type;
      if (type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
        textParts.push(part.text);
      } else if (type === 'tool') {
        toolParts.push(part);
      } else if (type === 'reasoning') {
        skipped += 1;
      } else if (typeof type === 'string') {
        skipped += 1;
      }
    }

    let messageSeq: number | undefined;
    const text = textParts.join('\n\n');
    if (text.length > 0) {
      messageSeq = nextSeq();
      const blob = put(text);
      const event: TraceEventInput<UserMessageEvent> | TraceEventInput<AssistantMessageEvent> =
        role === 'user'
          ? { seq: messageSeq, type: 'user_message', ts, blob, ...turn }
          : { seq: messageSeq, type: 'assistant_message', ts, blob, ...turn };
      events.push(event);
    }

    for (const toolPart of toolParts) {
      const state = isRecord(toolPart.state) ? toolPart.state : undefined;
      const toolName = typeof toolPart.tool === 'string' ? toolPart.tool : undefined;

      if (!toolName) {
        failures.push({ line: msgIndex, error: 'tool part has no "tool" name' });
        continue;
      }

      const input = state && isRecord(state.input) ? state.input : {};
      const callSeq = nextSeq();
      const callEvent: TraceEventInput<ToolCallEvent> = {
        seq: callSeq,
        type: 'tool_call',
        ts,
        tool: toolName,
        ...turn,
      };

      const path = firstString(input, ['filePath', 'file_path', 'path']);
      if (path !== undefined) callEvent.path = path;
      // D21: `bash` is one name over every phase; the command is what phases it.
      const command = firstString(input, ['command']);
      if (command !== undefined) callEvent.command = command.slice(0, COMMAND_CHARS);
      if (typeof input.content === 'string') callEvent.blob = put(input.content);
      if (Object.keys(input).length > 0) callEvent.args_blob = put(JSON.stringify(input));
      if (messageSeq !== undefined) callEvent.parent_seq = messageSeq;
      events.push(callEvent);

      if (state) {
        const status = state.status;
        if (status === 'completed' || status === 'error') {
          const resultSeq = nextSeq();
          const output = typeof state.output === 'string'
            ? state.output
            : state.output != null
              ? JSON.stringify(state.output)
              : '';
          const resultEvent: TraceEventInput<ToolResultEvent> = {
            seq: resultSeq,
            type: 'tool_result',
            ts: resultTs(state, ts),
            call_seq: callSeq,
            ...turn,
          };
          if (output.length > 0) resultEvent.output_blob = put(output);
          if (status === 'error') {
            resultEvent.error = output.slice(0, ERROR_DETAIL_CHARS) || 'tool reported an error';
          }
          events.push(resultEvent);
        }
      }
    }
  }

  return { events, failures, skipped, blobsWritten };
}

function epochMsToIso(...candidates: unknown[]): string {
  for (const v of candidates) {
    if (isRecord(v) && typeof v.created === 'number') {
      return new Date(v.created).toISOString();
    }
    if (typeof v === 'number' && v > 0) {
      return new Date(v).toISOString();
    }
  }
  return EPOCH;
}

function resultTs(state: Record<string, unknown>, fallback: string): string {
  const time = state.time;
  if (isRecord(time)) {
    if (typeof time.end === 'number') return new Date(time.end).toISOString();
    if (typeof time.start === 'number') return new Date(time.start).toISOString();
  }
  return fallback;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
