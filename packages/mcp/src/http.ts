/**
 * The HTTP transport over the tool registry — for a host plugin, which sits in the
 * prompt path and cannot afford MCP framing or a model turn per call.
 *
 *   GET  /v1/tools          the registry: name, description, JSON schema, transports
 *   POST /v1/tools/<name>   body = the tool's input; answers the handler's ToolOutcome
 *
 * Same handlers, same context, same session as the MCP server in this process — a
 * plugin's `context_evict` and an agent's are one state. Loopback only. The agent
 * under test usually shares that loopback and can run shell commands, so a bearer
 * token is supported: a stray POST must not be able to move the turn clock or evict.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { TOOLS, type ToolSpec } from './tools/index.js';
import type { ToolContext, ToolOutcome } from './types.js';

export interface HttpApiOptions {
  ctx: ToolContext;
  tools?: readonly ToolSpec[];
  /** 0 picks a free port. */
  port: number;
  token?: string;
  /** One row per request, after it is answered. Evidence, never control flow. */
  onCall?: (row: { tool: string; ok: boolean; ms: number; input: unknown; outcome: ToolOutcome<unknown> }) => void;
}

export interface HttpApi {
  port: number;
  close: () => Promise<void>;
}

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

export function createHttpApi(options: HttpApiOptions): Promise<HttpApi> {
  const tools = (options.tools ?? TOOLS).filter((t) => t.transports.includes('http'));
  const byName = new Map(tools.map((t) => [t.name, t]));

  const server = http.createServer((req, res) => {
    if (options.token !== undefined && options.token !== '' && req.headers.authorization !== `Bearer ${options.token}`) {
      send(res, 403, { code: 'forbidden', message: 'bad or missing bearer token' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/v1/tools') {
      send(res, 200, {
        tools: tools.map((t) => ({ name: t.name, title: t.title, description: t.description, transports: t.transports, input_schema: z.toJSONSchema(z.object(t.inputShape)) })),
      });
      return;
    }
    const match = /^\/v1\/tools\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    const tool = match !== null ? byName.get(match[1]!) : undefined;
    if (req.method !== 'POST' || tool === undefined) {
      send(res, 404, { code: 'unknown_tool', message: `no tool at ${req.method ?? ''} ${url.pathname}; GET /v1/tools lists them` });
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) req.destroy();
      else chunks.push(chunk);
    });
    req.on('end', () => {
      const started = Date.now();
      let input: unknown;
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        input = text === '' ? {} : JSON.parse(text);
      } catch {
        send(res, 400, { ok: false, error: { code: 'invalid_input', message: 'body is not JSON' } });
        return;
      }
      // A handler never throws across the boundary by contract; this is for the one that breaks it.
      tool.handler(options.ctx, input)
        .catch((error: unknown): ToolOutcome<never> => ({ ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } }))
        .then((outcome) => {
          send(res, 200, outcome);
          options.onCall?.({ tool: tool.name, ok: outcome.ok, ms: Date.now() - started, input, outcome });
        })
        .catch(() => undefined);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }),
      });
    });
  });
}
