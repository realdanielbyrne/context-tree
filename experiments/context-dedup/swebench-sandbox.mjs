/**
 * The agent's SANDBOX (bubblewrap). opencode, and every tool it runs, sees:
 *   - the host root READ-ONLY, with /home, /mnt, /media, /srv, /var/tmp and /run/user replaced by
 *     empty tmpfs and /tmp by a per-run directory;
 *   - inside those, only: the run's workspace and opencode XDG dirs (rw), a per-run $HOME (rw),
 *     the instance venv and its base interpreter (ro), the per-run opencode config (ro), and the
 *     pinned opencode + ripgrep binaries (ro);
 *   - NO network. The model endpoint is reached through a relay: socat inside listens on
 *     127.0.0.1:RELAY_PORT and forwards to a unix socket, where the runner proxies to the real
 *     endpoint and adds the API key. The agent holds no key and reaches nothing else.
 *
 * Why: unsandboxed agents read the answers — the dataset's gold and test patches, the fix commit
 * in repos/ (`git show`), later versions in wscache/, other runs' workspaces, and the released
 * fix via `pip download`. The PREFLIGHT proves the isolation inside the same sandbox before any
 * model call; a run whose preflight fails is never started.
 *
 * opencode would otherwise download ripgrep and models.json at start-up, so both are pinned in an
 * assets directory. OPENCODE_DISABLE_CLAUDE_CODE stops it loading ~/.claude/CLAUDE.md, which every
 * unsandboxed run received from the operator's real home.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const SANDBOX_ROOT = '/home/.ct-sandbox';
export const SANDBOX_BIN = `${SANDBOX_ROOT}/bin`;
export const SANDBOX_SOCK = `${SANDBOX_ROOT}/sock`;
export const SANDBOX_HOME = '/home/agent';
/** Where the MCP arm's built packages appear inside the sandbox (U5). */
export const SANDBOX_CT = `${SANDBOX_ROOT}/ct`;
export const RELAY_PORT = 8888;

/**
 * What the MCP arm needs inside the sandbox: node, the three builds, and the
 * dependency tree they resolve through.
 *
 * Bound one subtree at a time, never the repo root — `reports/` holds earlier
 * agents' diffs and the operator's home is the thing the sandbox exists to
 * hide. pnpm's links are relative (`../../../node_modules/.pnpm/...`), so the
 * same relative shape has to appear under `SANDBOX_CT` for them to resolve.
 */
export const MCP_PATHS = Object.freeze([
  'node_modules',
  'packages/core/package.json', 'packages/core/dist', 'packages/core/node_modules',
  'packages/mcp/package.json', 'packages/mcp/dist', 'packages/mcp/node_modules',
  'packages/cli/package.json', 'packages/cli/dist', 'packages/cli/node_modules',
  'experiments/context-dedup/ct-sidecar.mjs',
  'experiments/context-dedup/oc-plugin/ct-assemble-plugin.mjs',
]);
export const MCP_SCRIPT = `${SANDBOX_CT}/experiments/context-dedup/ct-sidecar.mjs`;
/** The prompt-assembly plugin, as opencode sees it from inside the sandbox. */
export const PLUGIN_SCRIPT = `${SANDBOX_CT}/experiments/context-dedup/oc-plugin/ct-assemble-plugin.mjs`;
export const MASKED = ['/home', '/mnt', '/media', '/srv', '/var/tmp', '/run/user'];

const which = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).stdout.trim() || null;

/** The venv's base interpreter installation (pyvenv.cfg `home` is its bin dir). */
export function pythonHomeOf(venv, read = (p) => readFileSync(p, 'utf8')) {
  const m = read(join(venv, 'pyvenv.cfg')).match(/^\s*home\s*=\s*(.+?)\s*$/m);
  if (!m) throw new Error(`no home in ${venv}/pyvenv.cfg`);
  return dirname(m[1]);
}

/**
 * The per-run opencode config: only the run's provider, its baseURL moved onto the relay and its
 * key replaced. Returns the real upstream and key for the proxy.
 */
export function sandboxConfig(cfg, model, env = process.env, { window = 0, mcp = null, plugin = false } = {}) {
  const [provider, ...rest] = model.split('/');
  const entry = cfg.provider?.[provider];
  if (!entry?.options?.baseURL) throw new Error(`provider ${provider} has no baseURL in the opencode config`);
  const upstream = new URL(entry.options.baseURL);
  const keyRef = String(entry.options.apiKey ?? '');
  const envKey = keyRef.match(/^\{env:(\w+)\}$/);
  const apiKey = envKey ? env[envKey[1]] ?? '' : keyRef;
  let models = entry.models;
  if (window > 0) {
    // opencode compacts at `limit.context − output cap`, so the declared context
    // IS the arm's window: the cap has to bind in the host, not in our arithmetic.
    const id = rest.join('/');
    const declared = models?.[id];
    if (!declared) throw new Error(`model ${id} has no entry under provider ${provider}: cannot set a window`);
    models = { ...models, [id]: { ...declared, limit: { ...declared.limit, context: window } } };
  }
  const inner = { ...entry, models, options: { ...entry.options, baseURL: `http://127.0.0.1:${RELAY_PORT}${upstream.pathname.replace(/\/$/, '')}`, apiKey: 'sandboxed' } };
  const config = { ...cfg, provider: { [provider]: inner } };
  if (mcp) {
    // `--pure` disables external PLUGINS, not MCP servers (verified against
    // 1.18.31 with `opencode mcp list --pure`), so the arm needs no flag change.
    config.mcp = {
      'context-tree': {
        type: 'local',
        command: ['node', MCP_SCRIPT],
        enabled: true,
        environment: {
          CT_REPO_ROOT: SANDBOX_CT,
          CT_MCP_ROOT: mcp.storeDir,
          CT_MCP_DB: mcp.db,
          CT_MCP_LOG: mcp.log,
          ...(mcp.pollMs ? { CT_MCP_POLL_MS: String(mcp.pollMs) } : {}),
          ...(mcp.env ?? {}),
        },
      },
    };
  }
  if (plugin) {
    config.plugin = [PLUGIN_SCRIPT];
    // Host compaction OFF so context-tree is the only reducer in this arm — otherwise a
    // result cannot be attributed, and the transform hook fires a second time on the
    // compaction head with an indistinguishable input. `auto:false` makes a genuine
    // overflow a hard session error, so the sidecar keeps the prompt under the real context.
    config.compaction = { auto: false };
  }
  return { config, upstream: entry.options.baseURL, apiKey };
}

/** HTTP proxy on a unix socket to `upstream`, injecting the key. Streams both ways. */
export function startModelProxy({ socketPath, upstream, apiKey }) {
  const u = new URL(upstream);
  const mod = u.protocol === 'https:' ? https : http;
  const server = http.createServer((req, res) => {
    const headers = { ...req.headers, host: u.host };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const up = mod.request({ protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, method: req.method, path: req.url, headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', (e) => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }); res.end(`sandbox proxy: ${e.message}`); });
    res.on('close', () => up.destroy());
    req.pipe(up);
  });
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve({ close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) }));
  });
}

/**
 * bwrap arguments, in mount order: the read-only root, the masks, then the allowed paths. A
 * symlinked path (the venv `home` often is one) is bound at its target and linked at its name.
 */
export function planSandbox({ ws, xdgRoot, sandboxDir, sockDir, venv, config, opencodeBin, rgBin, chdir = ws,
  mcp = null, exists = existsSync, realpath = realpathSync, readVenvCfg } = {}) {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc'];
  const masked = MASKED.filter((p) => exists(p));
  for (const p of masked) args.push('--tmpfs', p);
  args.push('--bind', join(sandboxDir, 'tmp'), '/tmp', '--bind', join(sandboxDir, 'home'), SANDBOX_HOME);
  args.push('--ro-bind', opencodeBin, `${SANDBOX_BIN}/opencode`, '--ro-bind', rgBin, `${SANDBOX_BIN}/rg`);
  args.push('--bind', sockDir, SANDBOX_SOCK);
  const visible = [];
  if (mcp) {
    args.push('--ro-bind', mcp.nodeBin, `${SANDBOX_BIN}/node`);
    for (const rel of MCP_PATHS) args.push('--ro-bind', join(mcp.repoRoot, rel), `${SANDBOX_CT}/${rel}`);
    args.push('--bind', mcp.storeParent, mcp.storeParent);
    visible.push(`${SANDBOX_CT} (ro: ${MCP_PATHS.length} paths)`, mcp.storeParent);
  }
  const ro = (p) => {
    const real = realpath(p);
    args.push('--ro-bind', real, real);
    if (real !== p) args.push('--symlink', real, p);
    visible.push(p);
  };
  ro(venv);
  ro(pythonHomeOf(venv, readVenvCfg));
  ro(config);
  for (const p of [xdgRoot, ws]) { args.push('--bind', p, p); visible.push(p); }
  args.push('--unshare-all', '--die-with-parent', '--chdir', chdir);
  return { args, masked, visible };
}

/** Start the relay(s), wait until listening, then become `opencode "$@"`. */
export function innerScript() {
  const hex = RELAY_PORT.toString(16).toUpperCase().padStart(4, '0');
  return [
    `socat TCP-LISTEN:${RELAY_PORT},bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:${SANDBOX_SOCK}/model.sock &`,
    'i=0',
    `until grep -q ":${hex} 00000000:0000 0A" /proc/net/tcp 2>/dev/null; do`,
    '  i=$((i+1)); [ $i -gt 100 ] && { echo "sandbox: relay did not start" >&2; exit 97; }; sleep 0.05',
    'done',
    'exec opencode "$@"',
  ].join('\n');
}

export function sandboxEnv({ venv, xdg, config, pythonPath, extra = {}, host = process.env }) {
  return {
    PATH: `${join(venv, 'bin')}:${SANDBOX_BIN}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    HOME: SANDBOX_HOME, TMPDIR: '/tmp', SHELL: '/bin/bash',
    LANG: host.LANG || 'C.UTF-8', TERM: host.TERM || 'dumb', USER: host.USER || 'agent', LOGNAME: host.LOGNAME || 'agent',
    ...xdg, OPENCODE_CONFIG: config, PYTHONPATH: pythonPath, PYTHONDONTWRITEBYTECODE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_SHARE: '1',
    ...extra,
  };
}

/**
 * Python 3.5-compatible probe run INSIDE the sandbox. Every check must be true.
 * `hidden` paths must not exist; `only` maps a directory to the exact entries it may contain.
 */
export function probeSource({ hidden, only, ws, importName }) {
  return `
import json, os, socket
r = {}
for p in ${JSON.stringify(hidden)}:
    r['hidden ' + p] = not os.path.exists(p)
for d, names in ${JSON.stringify(only)}.items():
    key = 'only ' + ','.join(names) + ' in ' + d
    try:
        r[key] = sorted(os.listdir(d)) == sorted(names)
    except OSError:
        r[key] = False
probe = os.path.join(${JSON.stringify(ws)}, '.ct-sandbox-probe')
try:
    open(probe, 'w').write('x'); os.remove(probe); r['workspace writable'] = True
except OSError:
    r['workspace writable'] = False
try:
    m = __import__(${JSON.stringify(importName)})
    r['imports from workspace'] = os.path.realpath(m.__file__).startswith(os.path.realpath(${JSON.stringify(ws)}) + os.sep)
except Exception:
    r['imports from workspace'] = False
try:
    socket.create_connection(('1.1.1.1', 443), timeout=3).close(); r['no outbound network'] = False
except OSError:
    r['no outbound network'] = True
try:
    socket.getaddrinfo('pypi.org', 443); r['no DNS'] = False
except OSError:
    r['no DNS'] = True
print(json.dumps(r))
`;
}

export function runPreflight({ bwrap, args, env, python, source }) {
  const p = spawnSync(bwrap, [...args, '--', python, '-c', source], { env, encoding: 'utf8', timeout: 120_000 });
  let checks = null;
  try { checks = JSON.parse(p.stdout.trim().split('\n').pop()); } catch {}
  const ok = !!checks && Object.values(checks).every((v) => v === true);
  return { ok, checks, exit: p.status, stderr: (p.stderr || '').slice(-600) };
}

/**
 * Everything one sandboxed run needs. Throws if the sandbox cannot be built or the preflight
 * fails. `close()` stops the proxy and removes the host socket directory.
 */
export async function openSandbox({ runDir, ws, xdg, venv, model, configPath, importName, pythonPath,
  hidden, only, assets, marker = {}, window = 0, mcp = null, plugin = false }) {
  const bwrap = which('bwrap');
  if (!bwrap) throw new Error('sandbox: bwrap not found');
  if (!which('socat')) throw new Error('sandbox: socat not found');
  const opencodeBin = realpathSync(which('opencode') || '');
  const rgBin = join(assets, 'rg');
  const models = join(assets, 'models.json');
  for (const p of [rgBin, models]) if (!existsSync(p)) throw new Error(`sandbox: missing pinned asset ${p}`);

  const sandboxDir = join(runDir, 'sandbox');
  for (const d of ['tmp', 'home']) mkdirSync(join(sandboxDir, d), { recursive: true });
  mkdirSync(join(xdg.XDG_CACHE_HOME, 'opencode'), { recursive: true });
  copyFileSync(models, join(xdg.XDG_CACHE_HOME, 'opencode', 'models.json'));

  const mcpPlan = mcp
    ? {
        repoRoot: mcp.repoRoot,
        nodeBin: realpathSync(which('node') || process.execPath),
        storeParent: join(runDir, 'mcp'),
        storeDir: join(runDir, 'mcp', 'store'),
        db: join(xdg.XDG_DATA_HOME, 'opencode', 'opencode.db'),
        log: join(runDir, 'mcp', 'ct-mcp.jsonl'),
        pollMs: mcp.pollMs,
      }
    : null;
  if (mcpPlan) {
    mkdirSync(mcpPlan.storeParent, { recursive: true });
    for (const rel of MCP_PATHS) {
      const p = join(mcpPlan.repoRoot, rel);
      if (!existsSync(p)) throw new Error(`sandbox: MCP arm needs ${p} (run the package build first)`);
    }
  }
  const { config, upstream, apiKey } = sandboxConfig(
    JSON.parse(readFileSync(configPath, 'utf8')),
    model,
    process.env,
    { window, mcp: mcpPlan, plugin },
  );
  const config_ = join(sandboxDir, 'opencode.json');
  writeFileSync(config_, JSON.stringify(config, null, 2));

  // A unix socket path is limited to 108 bytes; run dirs are longer, so the socket lives in /tmp.
  const sockDir = mkdtempSync(join(tmpdir(), 'ct-sbx-'));
  const proxy = await startModelProxy({ socketPath: join(sockDir, 'model.sock'), upstream, apiKey });
  const close = async () => { await proxy.close(); rmSync(sockDir, { recursive: true, force: true }); };
  try {
    const plan = planSandbox({ ws, xdgRoot: dirname(xdg.XDG_CONFIG_HOME), sandboxDir, sockDir, venv, config: config_, opencodeBin, rgBin, mcp: mcpPlan });
    const env = sandboxEnv({ venv, xdg, config: config_, pythonPath, extra: marker });
    const preflight = runPreflight({ bwrap, args: plan.args, env, python: join(venv, 'bin', 'python'), source: probeSource({ hidden, only, ws, importName }) });
    if (!preflight.ok) throw new Error(`sandbox preflight failed: ${JSON.stringify(preflight)}`);
    const bwrapVersion = spawnSync(bwrap, ['--version'], { encoding: 'utf8' }).stdout.trim();
    return {
      cmd: bwrap,
      args: plan.args,
      argsFor: (opencodeArgs) => [...plan.args, '--', '/bin/sh', '-c', innerScript(), 'ct-sandbox', ...opencodeArgs],
      env,
      close,
      record: {
        enabled: true, tool: bwrapVersion, network: `none; model relay 127.0.0.1:${RELAY_PORT} -> ${upstream}`,
        masked: plan.masked, visible: plan.visible, config: config_, preflight: preflight.checks,
        mcp: mcpPlan ? { script: MCP_SCRIPT, store: mcpPlan.storeDir, log: mcpPlan.log, db: mcpPlan.db } : null,
        window: window > 0 ? window : null,
      },
    };
  } catch (e) { await close(); throw e; }
}

/** bwrap reports a signal-killed child as exit 128+N; recover the signal for the exit classifier. */
export function exitFromSandbox(code, signal, signals) {
  if (signal !== null || code === null || code <= 128 || code > 128 + 64) return { code, signal };
  const name = Object.keys(signals).find((k) => signals[k] === code - 128);
  return name ? { code: null, signal: name } : { code, signal };
}
