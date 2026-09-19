import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir, constants } from 'node:os';
import { join } from 'node:path';
import {
  sandboxConfig, planSandbox, exitFromSandbox, startModelProxy, pythonHomeOf, probeSource, runPreflight,
  makeWireCounter,
  sandboxEnv, innerScript, SANDBOX_BIN, SANDBOX_HOME, RELAY_PORT, SANDBOX_CT, MCP_PATHS, MCP_SCRIPT,
} from './swebench-sandbox.mjs';
import { sandboxExpectations } from './swebench-opencode.mjs';

const have = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
const LIVE = have('bwrap') && have('socat') && spawnSync('bwrap', ['--ro-bind', '/', '/', '--unshare-all', 'true']).status === 0;

const CFG = {
  $schema: 'x',
  provider: {
    local: { npm: 'n', options: { baseURL: 'http://127.0.0.1:8888/v1', apiKey: '{env:K1}' }, models: { m: {} } },
    openrouter: { npm: 'n', options: { baseURL: 'https://openrouter.ai/api/v1', apiKey: '{env:K2}' }, models: { q: {} } },
  },
};

test('sandboxConfig keeps only the run provider, moves it onto the relay, withholds the key', () => {
  const r = sandboxConfig(CFG, 'openrouter/q', { K2: 'secret' });
  assert.deepEqual(Object.keys(r.config.provider), ['openrouter']);
  assert.equal(r.config.provider.openrouter.options.baseURL, `http://127.0.0.1:${RELAY_PORT}/api/v1`);
  assert.equal(r.config.provider.openrouter.options.apiKey, 'sandboxed');
  assert.deepEqual(r.config.provider.openrouter.models, { q: {} });
  assert.equal(r.upstream, 'https://openrouter.ai/api/v1');
  assert.equal(r.apiKey, 'secret');
  assert.equal(sandboxConfig(CFG, 'local/m', { K1: 'k' }).config.provider.local.options.baseURL, `http://127.0.0.1:${RELAY_PORT}/v1`);
  assert.throws(() => sandboxConfig(CFG, 'nope/x'), /no baseURL/);
});

test('planSandbox mounts the read-only root, then the masks, then only the allowed paths', () => {
  const { args, masked, visible } = planSandbox({
    ws: '/mnt/r/run/workspace', xdgRoot: '/mnt/r/run/xdg', sandboxDir: '/mnt/r/run/sandbox', sockDir: '/tmp/s',
    venv: '/mnt/w/venvs/v', config: '/mnt/r/run/sandbox/opencode.json', opencodeBin: '/o/opencode.exe', rgBin: '/a/rg',
    exists: (p) => p !== '/media',
    realpath: (p) => (p === '/mnt/w/py/link' ? '/mnt/w/py/real' : p),
    readVenvCfg: () => 'include-system-site-packages = false\nhome = /mnt/w/py/link/bin\n',
  });
  assert.deepEqual(args.slice(0, 3), ['--ro-bind', '/', '/']);
  assert.ok(!masked.includes('/media') && masked.includes('/home') && masked.includes('/mnt'));
  const firstBind = args.findIndex((a, i) => (a === '--bind' || a === '--ro-bind') && i > 0);
  const lastMask = args.lastIndexOf('--tmpfs');
  assert.ok(lastMask < firstBind, 'every mask precedes every allowed path');
  const pair = (flag, src) => args.some((a, i) => a === flag && args[i + 1] === src);
  assert.ok(pair('--ro-bind', '/mnt/w/py/real') && pair('--symlink', '/mnt/w/py/real'));
  assert.ok(pair('--ro-bind', '/o/opencode.exe') && args[args.indexOf('/o/opencode.exe') + 1] === `${SANDBOX_BIN}/opencode`);
  assert.ok(pair('--bind', '/mnt/r/run/workspace') && pair('--bind', '/mnt/r/run/xdg'));
  assert.ok(args.includes('--unshare-all') && !args.includes('--share-net'));
  assert.deepEqual(visible, ['/mnt/w/venvs/v', '/mnt/w/py/link', '/mnt/r/run/sandbox/opencode.json', '/mnt/r/run/xdg', '/mnt/r/run/workspace']);
});

test('pythonHomeOf reads the venv home', () => {
  assert.equal(pythonHomeOf('/v', () => 'home = /opt/py/bin\nversion = 3.9'), '/opt/py');
  assert.throws(() => pythonHomeOf('/v', () => 'version = 3.9'), /no home/);
});

test('exitFromSandbox recovers the signal bwrap folds into its exit code', () => {
  assert.deepEqual(exitFromSandbox(143, null, constants.signals), { code: null, signal: 'SIGTERM' });
  assert.deepEqual(exitFromSandbox(0, null, constants.signals), { code: 0, signal: null });
  assert.deepEqual(exitFromSandbox(1, null, constants.signals), { code: 1, signal: null });
  assert.deepEqual(exitFromSandbox(null, 'SIGKILL', constants.signals), { code: null, signal: 'SIGKILL' });
});

test('sandboxExpectations pins every masked ancestor to the entries the run needs', () => {
  const e = sandboxExpectations({
    work: '/mnt/data/w', runsRoot: '/mnt/data/w/runs-oc', tag: 't', runDir: '/mnt/data/w/runs-oc/t/i__r0',
    venv: '/mnt/data/w/venvs/v', pythonHomes: ['/mnt/data/w/tooling/py/link', '/mnt/data/w/tooling/py/real'], home: '/home/u', repo: '/home/u/r',
    exists: (p) => p !== '/snap',
  });
  assert.deepEqual(e.only['/usr/lib/python3/dist-packages'], []);
  assert.ok(!('/snap' in e.only), 'a library mask the host lacks is not asserted');
  assert.deepEqual(e.only['/mnt'], ['data']);
  assert.deepEqual(e.only['/mnt/data'], ['w']);
  assert.deepEqual(e.only['/mnt/data/w'].sort(), ['runs-oc', 'tooling', 'venvs']);
  assert.deepEqual(e.only['/mnt/data/w/venvs'], ['v']);
  assert.deepEqual(e.only['/mnt/data/w/tooling/py'].sort(), ['link', 'real']);
  assert.deepEqual(e.only['/mnt/data/w/runs-oc'], ['t']);
  assert.deepEqual(e.only['/mnt/data/w/runs-oc/t'], ['i__r0']);
  assert.ok(e.hidden.includes('/mnt/data/w/dataset') && e.hidden.includes('/mnt/data/w/repos') && e.hidden.includes('/home/u'));
});

test('startModelProxy forwards and streams, replacing host and key', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, host: req.headers.host, body });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: 1\n\n');
      setTimeout(() => res.end('data: 2\n\n'), 50);
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'ct-proxy-'));
  const sock = join(dir, 'm.sock');
  const proxy = await startModelProxy({ socketPath: sock, upstream: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'real' });
  try {
    const out = await new Promise((resolve, reject) => {
      const req = http.request({ socketPath: sock, method: 'POST', path: '/v1/chat', headers: { authorization: 'Bearer sandboxed', host: '127.0.0.1:8888' } }, (res) => {
        let s = '';
        res.on('data', (c) => { s += c; });
        res.on('end', () => resolve({ status: res.statusCode, s }));
      });
      req.on('error', reject);
      req.end('{"x":1}');
    });
    assert.equal(out.status, 200);
    assert.equal(out.s, 'data: 1\n\ndata: 2\n\n');
    assert.deepEqual(seen, [{ url: '/v1/chat', auth: 'Bearer real', host: `127.0.0.1:${upstream.address().port}`, body: '{"x":1}' }]);
  } finally {
    await proxy.close();
    upstream.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function liveLayout() {
  const root = mkdtempSync(join(tmpdir(), 'ct-sbx-test-'));
  const runDir = join(root, 'run');
  const ws = join(runDir, 'workspace');
  const secret = join(root, 'secret');
  const venv = join(root, 'venv');
  for (const d of [join(ws, 'ctpkg'), join(runDir, 'xdg', 'config'), join(runDir, 'sandbox', 'tmp'), join(runDir, 'sandbox', 'home'), secret, join(venv, 'bin')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(ws, 'ctpkg', '__init__.py'), '');
  writeFileSync(join(secret, 'gold.patch'), 'answer');
  const py = spawnSync('sh', ['-c', 'readlink -f "$(command -v python3)"'], { encoding: 'utf8' }).stdout.trim();
  symlinkSync(py, join(venv, 'bin', 'python'));
  writeFileSync(join(venv, 'pyvenv.cfg'), `home = ${join(py, '..')}\n`);
  writeFileSync(join(runDir, 'sandbox', 'opencode.json'), '{}');
  const sockDir = join(root, 'sock');
  mkdirSync(sockDir);
  return { root, runDir, ws, secret, venv, sockDir, py };
}

test('LIVE: preflight passes in the sandbox, and fails when a hidden path is visible', { skip: !LIVE && 'bwrap/socat unavailable' }, () => {
  const L = liveLayout();
  try {
    const plan = planSandbox({ ws: L.ws, xdgRoot: join(L.runDir, 'xdg'), sandboxDir: join(L.runDir, 'sandbox'), sockDir: L.sockDir,
      venv: L.venv, config: join(L.runDir, 'sandbox', 'opencode.json'), opencodeBin: '/bin/true', rgBin: '/bin/true' });
    const env = sandboxEnv({ venv: L.venv, xdg: { XDG_CONFIG_HOME: join(L.runDir, 'xdg', 'config') }, config: '/x', pythonPath: L.ws });
    const pass = runPreflight({ bwrap: 'bwrap', args: plan.args, env, python: join(L.venv, 'bin', 'python'),
      source: probeSource({ hidden: [L.secret], only: { [SANDBOX_HOME]: [] }, ws: L.ws, importName: 'ctpkg' }) });
    assert.equal(pass.ok, true, JSON.stringify(pass));
    assert.equal(pass.checks['no outbound network'], true);
    assert.equal(pass.checks[`hidden ${L.secret}`], true);
    const fail = runPreflight({ bwrap: 'bwrap', args: plan.args, env, python: join(L.venv, 'bin', 'python'),
      source: probeSource({ hidden: [L.ws], only: {}, ws: L.ws, importName: 'ctpkg' }) });
    assert.equal(fail.ok, false);
    assert.equal(fail.checks[`hidden ${L.ws}`], false);
  } finally { rmSync(L.root, { recursive: true, force: true }); }
});

test('LIVE: the only way out is the model relay, and it carries the real key', { skip: !LIVE && 'bwrap/socat unavailable' }, async () => {
  const L = liveLayout();
  const seen = [];
  const upstream = http.createServer((req, res) => { seen.push(req.headers.authorization); res.end('pong'); });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const proxy = await startModelProxy({ socketPath: join(L.sockDir, 'model.sock'), upstream: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'real' });
  // Stands in for opencode: calls the relay, then tries the upstream directly.
  const fake = join(L.root, 'fake-opencode');
  writeFileSync(fake, `#!/bin/sh
python -c "
import urllib.request
print(urllib.request.urlopen('http://127.0.0.1:${RELAY_PORT}/v1/models').read().decode())
try:
    urllib.request.urlopen('http://127.0.0.1:${upstream.address().port}/v1/models', timeout=3); print('direct: reachable')
except Exception:
    print('direct: blocked')
print('args:', '$*')
"
`);
  chmodSync(fake, 0o755);
  try {
    const plan = planSandbox({ ws: L.ws, xdgRoot: join(L.runDir, 'xdg'), sandboxDir: join(L.runDir, 'sandbox'), sockDir: L.sockDir,
      venv: L.venv, config: join(L.runDir, 'sandbox', 'opencode.json'), opencodeBin: fake, rgBin: '/bin/true' });
    const env = sandboxEnv({ venv: L.venv, xdg: {}, config: '/x', pythonPath: L.ws });
    const out = await new Promise((resolve) => {
      const p = spawn('bwrap', [...plan.args, '--', '/bin/sh', '-c', innerScript(), 'ct-sandbox', 'run', '--pure'], { env });
      let s = '';
      p.stdout.on('data', (c) => { s += c; });
      p.stderr.on('data', (c) => { s += c; });
      p.on('close', (code) => resolve({ code, s }));
    });
    assert.equal(out.code, 0, out.s);
    assert.match(out.s, /^pong$/m);
    assert.match(out.s, /direct: blocked/);
    assert.match(out.s, /args: run --pure/);
    assert.deepEqual(seen, ['Bearer real']);
  } finally {
    await proxy.close();
    upstream.close();
    rmSync(L.root, { recursive: true, force: true });
  }
});


test('sandboxConfig caps the window by declaring it, because opencode compacts at context - output cap', () => {
  const { config } = sandboxConfig(
    { ...CFG, provider: { ...CFG.provider, local: { ...CFG.provider.local, models: { m: { limit: { context: 151040, output: 32000 } } } } } },
    'local/m', { K1: 'k' }, { window: 50347 },
  );
  assert.equal(config.provider.local.models.m.limit.context, 50347);
  assert.equal(config.provider.local.models.m.limit.output, 32000, 'only the context moves');
});

test('sandboxConfig refuses a window for a model the config never declared, rather than silently not capping', () => {
  assert.throws(() => sandboxConfig(CFG, 'local/absent', { K1: 'k' }, { window: 1000 }), /no entry under provider/);
});

test('sandboxConfig adds the MCP server only when the arm asks for it, pointing at the in-sandbox script', () => {
  const off = sandboxConfig(CFG, 'local/m', { K1: 'k' });
  assert.equal(off.config.mcp, undefined, 'the control arm must not carry the server');
  const { config } = sandboxConfig(CFG, 'local/m', { K1: 'k' }, {
    mcp: { storeDir: '/run/mcp/store', db: '/run/xdg/data/opencode/opencode.db', log: '/run/mcp/l.jsonl' },
  });
  assert.deepEqual(config.mcp['context-tree'].command, ['node', MCP_SCRIPT]);
  assert.equal(config.mcp['context-tree'].environment.CT_REPO_ROOT, SANDBOX_CT);
  assert.equal(config.mcp['context-tree'].environment.CT_MCP_ROOT, '/run/mcp/store');
});

test('planSandbox binds node and the builds for the MCP arm, and nothing of the repo beyond them', () => {
  const base = {
    ws: '/mnt/r/run/workspace', xdgRoot: '/mnt/r/run/xdg', sandboxDir: '/mnt/r/run/sandbox', sockDir: '/tmp/s',
    venv: '/mnt/w/venvs/v', config: '/mnt/r/run/sandbox/opencode.json', opencodeBin: '/o/opencode', rgBin: '/a/rg',
    exists: () => true, realpath: (p) => p,
    readVenvCfg: () => 'home = /mnt/w/py/bin\n',
  };
  const { args } = planSandbox({
    ...base,
    mcp: { repoRoot: '/repo', nodeBin: '/n/node', storeParent: '/mnt/r/run/mcp' },
  });
  const dest = (src) => args[args.indexOf(src) + 1];
  assert.equal(dest('/n/node'), `${SANDBOX_BIN}/node`);
  for (const rel of MCP_PATHS) assert.equal(dest(`/repo/${rel}`), `${SANDBOX_CT}/${rel}`, `${rel} is bound`);
  assert.ok(!args.includes('/repo'), 'the repo root itself is never bound: reports/ holds earlier agents\' diffs');
  assert.ok(args.some((a, i) => a === '--bind' && args[i + 1] === '/mnt/r/run/mcp'), 'the store is writable');
  assert.equal(planSandbox(base).args.includes('/n/node'), false, 'the control arm gets no node');
});

/**
 * The wire record is the ONLY evidence gate G0 accepts, so the ways it can be quietly
 * wrong are the ways every arm can be quietly wrong: a marker lost at a chunk boundary
 * reads as a splice that fired, and a marker counted twice reads as one that did not.
 */
test('the wire counter finds a needle split across chunks, and counts it once', () => {
  const counter = makeWireCounter({ g0: 'CTG0-abcdef', role: '"role":' });
  counter.push(Buffer.from('{"role":"user","text":"CTG'));
  counter.push(Buffer.from('0-abcdef"}'));
  assert.deepEqual(counter.counts(), { g0: 1, role: 1 });
});

test('the wire counter never double-counts the carry it re-examines', () => {
  const counter = makeWireCounter({ g0: 'MARK' });
  // MARK lands wholly inside the tail that is carried into the next push.
  counter.push(Buffer.from('....MARK'));
  counter.push(Buffer.from('....'));
  counter.push(Buffer.from('MARK'));
  assert.equal(counter.counts().g0, 2);
});

test('the wire counter is byte-exact across a split multibyte character', () => {
  const utf8 = Buffer.from('{"role":"user","t":"é MARK"}', 'utf8');
  const counter = makeWireCounter({ g0: 'MARK', role: '"role":' });
  // Split INSIDE the two-byte é: a utf8-decoding counter would replace both halves.
  const cut = utf8.indexOf(0xc3) + 1;
  counter.push(utf8.subarray(0, cut));
  counter.push(utf8.subarray(cut));
  assert.deepEqual(counter.counts(), { g0: 1, role: 1 });
});

test('startModelProxy records what went upstream without changing it', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { seen.push(body); res.writeHead(201).end('ok'); });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'ct-wire-'));
  const wireLog = join(dir, 'wire.jsonl');
  const proxy = await startModelProxy({
    socketPath: join(dir, 'm.sock'), upstream: `http://127.0.0.1:${upstream.address().port}/v1`,
    apiKey: 'real', wireLog, needles: { g0: 'CTG0-zz' },
  });
  const payload = '{"tools":[],"messages":[{"role":"system"},{"role":"user","c":"CTG0-zz"}]}';
  try {
    await new Promise((resolve, reject) => {
      const req = http.request({ socketPath: join(dir, 'm.sock'), method: 'POST', path: '/v1/chat' }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.end(payload);
    });
    // The relay observes; the bytes upstream are the bytes the client sent.
    assert.deepEqual(seen, [payload]);
    const rows = readFileSync(wireLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].bytes, Buffer.byteLength(payload));
    assert.equal(rows[0].status, 201);
    assert.equal(rows[0].path, '/v1/chat');
    assert.deepEqual(rows[0].counts, { role: 2, tools: 1, g0: 1 });
    // The relay numbers its rows, so a lost one leaves a visible gap rather than reading
    // as a run that stopped making requests.
    assert.equal(rows[0].n, 1);
    assert.match(rows[0].sha256, /^[0-9a-f]{64}$/);
  } finally {
    await proxy.close();
    upstream.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty needle is dropped rather than hanging the relay', () => {
  const counter = makeWireCounter({ empty: '', g0: 'MARK' });
  counter.push(Buffer.from('a MARK b'));
  assert.deepEqual(counter.counts(), { g0: 1 });
});

test('the arm knobs reach the sidecar through the config, not just the plan', () => {
  // `openSandbox` builds the plan that `sandboxConfig` reads; for a whole arm's life the
  // plan dropped `env`, so every knob stopped here and the sidecar booted on its defaults.
  const { config } = sandboxConfig(CFG, 'local/m', { K1: 'k' }, {
    mcp: {
      storeDir: '/run/mcp/store', db: '/run/xdg/data/opencode/opencode.db', log: '/run/mcp/l.jsonl',
      env: { CT_CT_TRIGGER: 'soft', CT_CT_WINDOW: '50347' },
    },
  });
  const environment = config.mcp['context-tree'].environment;
  assert.equal(environment.CT_CT_TRIGGER, 'soft');
  assert.equal(environment.CT_CT_WINDOW, '50347');
});

test('a caller cannot quietly redefine a reserved wire needle', () => {
  // `role` and `tools` are what every reader of the log filters on; shadowing one would
  // change what "a hook-mediated request" means without any reader knowing.
  const dir = mkdtempSync(join(tmpdir(), 'ct-wire2-'));
  try {
    // Refused before the server is ever created, so there is nothing to clean up.
    assert.throws(
      () => startModelProxy({ socketPath: join(dir, 'm.sock'), upstream: 'http://127.0.0.1:1/v1', apiKey: 'k', needles: { tools: 'x' } }),
      /reserved/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
