// Real installed Codex; synthetic accounts with local bootstrap/model services.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Pool, codexBinary, codexEnv } from '../src/core.mjs';
import { SocketRpc, LiveSwitch, tokenBundle } from '../src/live.mjs';
import { traceRpcResponse } from './protocol-diagnostics.mjs';

process.umask(0o077);
const trace = process.argv.includes('--trace')
  ? message => console.error(`[protocol] ${message}`)
  : () => {};
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-protocol-'));
const home = path.join(root, 'live'); fs.mkdirSync(home, { mode: 0o700 });
const socket = path.join(home, 'control.sock');
const pool = new Pool(path.join(root, 'pool'));
const percent = { alpha: 80, beta: 60 };
const originals = new Map();
const syntheticTokens = new Map();
for (const name of Object.keys(percent)) {
  const accountHome = path.join(root, name); fs.mkdirSync(accountHome, { mode: 0o700 });
  const payload = Buffer.from(JSON.stringify({ sub: name, email: `${name}@example.test`, exp: Math.floor(Date.now()/1000)+3600,
    'https://api.openai.com/auth': { chatgpt_account_id: name, chatgpt_plan_type: 'plus', chatgpt_user_id: name } })).toString('base64url');
  const token = `eyJhbGciOiJub25lIn0.${payload}.synthetic`;
  syntheticTokens.set(`Bearer ${token}`, name);
  const text = JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: token, access_token: token, refresh_token: 'synthetic-only', account_id: name } });
  fs.writeFileSync(path.join(accountHome, 'auth.json'), text, { mode: 0o600 });
  originals.set(accountHome, text); pool.add(name, accountHome, true);
}
const requests = [];
const routingAccounts = new Set();
const upstream = http.createServer((req, res) => {
  req.resume();
  if (req.method === 'GET' && ['/backend-api/wham/accounts/check', '/backend-api/wham/config/bundle'].includes(req.url)) {
    const name = syntheticTokens.get(req.headers.authorization);
    if (!name || req.headers['chatgpt-account-id'] !== name) {
      res.writeHead(401); res.end('{}'); return;
    }
    const routing = req.url.endsWith('/accounts/check');
    if (routing) routingAccounts.add(name);
    trace(`local ${routing ? 'workspace routing' : 'config bundle'} request received`);
    res.writeHead(200, { 'content-type': 'application/json' });
    // Codex requires an HTTPS routing origin. This reserved, non-resolving
    // origin is metadata only: the custom model provider stays on local /v1.
    res.end(JSON.stringify(routing ? { accounts: [{ id: name,
      workspace_backend_origin: 'https://fixture.invalid', account_routing_override: 'NO_CONSTRAINT',
    }] } : { requirements_toml: {} }));
    return;
  }
  if (!req.url.endsWith('/responses')) { res.writeHead(404); res.end('{}'); return; }
  let identity;
  try { identity = JSON.parse(Buffer.from(req.headers.authorization.split('.')[1], 'base64url').toString()).sub; } catch { identity = 'missing'; }
  requests.push(identity);
  trace(`local model request ${requests.length} received`);
  const id = `resp_${requests.length}`;
  const item = { id: `msg_${requests.length}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] };
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = obj => res.write(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`);
  send({ type: 'response.created', response: { id, status: 'in_progress', output: [] } });
  send({ type: 'response.output_item.done', output_index: 0, item });
  send({ type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
  res.end();
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${upstream.address().port}`;
const base = `${origin}/v1`;
const model = { name: 'Local synthetic fixture', base_url: base, wire_api: 'responses', requires_openai_auth: true, supports_websockets: false };
const providerConfig = '{' + Object.entries(model).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(',') + '}';
const server = spawn(codexBinary(), ['app-server', '--listen', `unix://${socket}`, '-c', 'cli_auth_credentials_store="ephemeral"',
  '-c', `chatgpt_base_url=${JSON.stringify(`${origin}/backend-api/`)}`,
  '-c', 'model_provider="fixture"', '-c', `model_providers.fixture=${providerConfig}`], {
  cwd: home, env: { ...codexEnv(home), CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
});
server.stdout.resume(); server.stderr.resume();
server.once('exit', (code, signal) => trace(`app-server exited (code=${code}, signal=${signal})`));
let rpc, monitor;
try {
  trace('waiting for app-server socket');
  for (let i=0; i<200 && !fs.existsSync(socket); i++) {
    if (server.exitCode !== null) throw Error('Synthetic server startup failed.');
    await new Promise(r=>setTimeout(r,50));
  }
  if (!fs.existsSync(socket)) throw Error('Synthetic server socket did not become ready.');
  trace('socket ready; connecting');
  rpc = new SocketRpc(socket);
  if (process.argv.includes('--trace')) rpc.ws.on('message', data => {
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    if (message.method === 'account/chatgptAuthTokens/refresh') {
      trace('server requested token refresh');
    } else if (message.method === 'account/login/completed') {
      trace('server notified login completion');
    } else if (message.method === 'account/updated') {
      trace('server notified account update');
    } else if (!message.method && message.id !== undefined) {
      traceRpcResponse(message, trace);
    }
  });
  const request = rpc.request.bind(rpc);
  rpc.request = async (method, params) => {
    const started = Date.now();
    trace(`${method} started`);
    try {
      const result = await request(method, params);
      trace(`${method} completed (${Date.now() - started} ms)`);
      return result;
    } catch (error) {
      // Method names are safe to report; request/response bodies contain credentials.
      trace(`${method} failed (${Date.now() - started} ms)`);
      throw new Error(`${method}: ${error.message}`, { cause: error });
    }
  };
  await rpc.initialize();
  const limits = name => ({ rateLimits: { primary: { usedPercent: 100-percent[name], resetsAt: Date.now()/1000+3600 } } });
  // Quota is controlled locally; login and all model-turn RPCs use real Codex.
  const adapter = {
    request: (method, params) => method === 'account/rateLimits/read' ? Promise.resolve(limits(monitor.active.name)) : rpc.request(method, params),
    drainControllerRequests: () => rpc.drainControllerRequests(),
  };
  Object.defineProperty(adapter, 'refresh', { set(value) {
    rpc.refresh = async params => {
      trace('token refresh handler started');
      try {
        const result = await value(params);
        trace('token refresh handler completed');
        return result;
      } catch (error) {
        trace('token refresh handler failed');
        throw error;
      }
    };
  } });
  monitor = new LiveSwitch(pool, adapter, {
    probeAccount: async (_pool, name) => ({ ...pool.get(name), state: 'ready', plan: 'plus', checkedAt: new Date().toISOString(), limits: limits(name) }),
    // Synthetic tokens are served locally, never sent through OAuth refresh.
    refreshAccount: async account => tokenBundle(account),
  });
  assert.equal(await monitor.pickAlternative(), true);
  assert.equal(monitor.active.name, 'alpha');
  const thread = (await rpc.request('thread/start', { model: 'gpt-6-sol', cwd: home, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true })).thread;
  async function turn() {
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { rpc.off('notification', listener); reject(Error('Synthetic turn timed out.')); }, 20000);
      const listener = msg => { if (msg.method === 'turn/completed' && msg.params.threadId === thread.id) {
        clearTimeout(timer); rpc.off('notification', listener); resolve(msg.params.turn);
      } };
      rpc.on('notification', listener);
    });
    await rpc.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Reply OK.' }] });
    const result = await done; assert.equal(result.status, 'completed');
  }
  await turn();
  const beforeDiskSwitch = (await rpc.request('account/read', { refreshToken: false })).account.email;
  fs.writeFileSync(path.join(home, 'auth.json'), originals.get(pool.get('beta').home), { mode: 0o600 });
  await turn();
  const afterDiskSwitch = (await rpc.request('account/read', { refreshToken: false })).account.email;
  assert.equal(beforeDiskSwitch, 'alpha@example.test'); assert.equal(afterDiskSwitch, beforeDiskSwitch);
  assert.deepEqual(requests, ['alpha', 'alpha']);
  fs.rmSync(path.join(home, 'auth.json'));
  percent.alpha = 5; await monitor.tick();
  assert.equal(monitor.active.name, 'beta'); await turn();
  assert.deepEqual(requests, ['alpha', 'alpha', 'beta']);
  assert.deepEqual([...routingAccounts].sort(), ['alpha', 'beta']);
  if (process.argv.includes('--ui-smoke')) {
    console.log('Opening synthetic native UI; exit with Ctrl-C without entering a prompt.');
    const ignoreInterrupt = () => {};
    process.on('SIGINT', ignoreInterrupt);
    try {
      const ui = spawn(codexBinary(), ['--remote', `unix://${socket}`, '--no-alt-screen', '-C', home, '--sandbox', 'read-only'], { env: codexEnv(home), stdio: 'inherit' });
      const code = await new Promise((resolve, reject) => { ui.once('error', reject); ui.once('exit', resolve); });
      assert.equal(code, 0);
      assert.deepEqual(requests, ['alpha', 'alpha', 'beta']);
      console.log('Native remote UI smoke passed (no additional model request).');
    } finally { process.off('SIGINT', ignoreInterrupt); }
  }
  for (const [dir, text] of originals) assert.equal(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'), text);
  assert.equal(fs.existsSync(path.join(home, 'auth.json')), false);
  console.log(JSON.stringify({ passed: true, sameThread: true, diskReplacementIgnoredByRunningService: true,
    requestAccounts: requests, localWorkspaceRouting: true, automaticQuotaTrigger: true, canonicalCredentialsUnchanged: true, runtimeCredentialsOnDisk: false }));
} catch (e) { console.error('Protocol verification failed:', e.message); process.exitCode = 1; }
finally {
  rpc?.close(); await monitor?.close();
  if (server.exitCode === null) { const exited = new Promise(r=>server.once('exit', r)); server.kill('SIGTERM'); const timer=setTimeout(()=>server.kill('SIGKILL'),3000); await exited; clearTimeout(timer); }
  upstream.closeAllConnections(); await new Promise(r=>upstream.close(r));
  console.log(`Synthetic scratch retained: ${root}`);
}
