// Real installed Codex; synthetic accounts and localhost model responses only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Pool, codexBinary, codexEnv } from '../src/core.mjs';
import { SocketRpc, LiveSwitch } from '../src/live.mjs';

process.umask(0o077);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-protocol-'));
const home = path.join(root, 'live'); fs.mkdirSync(home, { mode: 0o700 });
const socket = path.join(home, 'control.sock');
const pool = new Pool(path.join(root, 'pool'));
const percent = { alpha: 80, beta: 60 };
const originals = new Map();
for (const name of Object.keys(percent)) {
  const accountHome = path.join(root, name); fs.mkdirSync(accountHome, { mode: 0o700 });
  const payload = Buffer.from(JSON.stringify({ sub: name, email: `${name}@example.test`, exp: Math.floor(Date.now()/1000)+3600,
    'https://api.openai.com/auth': { chatgpt_account_id: name, chatgpt_plan_type: 'plus', chatgpt_user_id: name } })).toString('base64url');
  const token = `eyJhbGciOiJub25lIn0.${payload}.synthetic`;
  const text = JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: token, access_token: token, refresh_token: 'synthetic-only', account_id: name } });
  fs.writeFileSync(path.join(accountHome, 'auth.json'), text, { mode: 0o600 });
  originals.set(accountHome, text); pool.add(name, accountHome, true);
}
const requests = [];
const upstream = http.createServer((req, res) => {
  req.resume();
  if (!req.url.endsWith('/responses')) { res.writeHead(404); res.end('{}'); return; }
  let identity;
  try { identity = JSON.parse(Buffer.from(req.headers.authorization.split('.')[1], 'base64url').toString()).sub; } catch { identity = 'missing'; }
  requests.push(identity);
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
const base = `http://127.0.0.1:${upstream.address().port}/v1`;
const model = { name: 'Local synthetic fixture', base_url: base, wire_api: 'responses', requires_openai_auth: true, supports_websockets: false };
const providerConfig = '{' + Object.entries(model).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(',') + '}';
const server = spawn(codexBinary(), ['app-server', '--listen', `unix://${socket}`, '-c', 'cli_auth_credentials_store="ephemeral"',
  '-c', 'model_provider="fixture"', '-c', `model_providers.fixture=${providerConfig}`], {
  cwd: home, env: { ...codexEnv(home), CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
});
server.stdout.resume(); server.stderr.resume();
let rpc, monitor;
try {
  for (let i=0; i<200 && !fs.existsSync(socket); i++) {
    if (server.exitCode !== null) throw Error('Synthetic server startup failed.');
    await new Promise(r=>setTimeout(r,50));
  }
  rpc = new SocketRpc(socket); await rpc.initialize();
  const limits = name => ({ rateLimits: { primary: { usedPercent: 100-percent[name], resetsAt: Date.now()/1000+3600 } } });
  // Quota is controlled locally; login and all model-turn RPCs use real Codex.
  const adapter = { request: (method, params) => method === 'account/rateLimits/read' ? Promise.resolve(limits(monitor.active.name)) : rpc.request(method, params) };
  Object.defineProperty(adapter, 'refresh', { set(value) { rpc.refresh = value; } });
  monitor = new LiveSwitch(pool, adapter, { probeAccount: async (_pool, name) => ({ ...pool.get(name), state: 'ready', plan: 'plus', checkedAt: new Date().toISOString(), limits: limits(name) }) });
  assert.equal(await monitor.pickAlternative(), true);
  assert.equal(monitor.active.name, 'alpha');
  const thread = (await rpc.request('thread/start', { model: 'gpt-5.6-terra', cwd: home, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true })).thread;
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
  await turn(); percent.alpha = 5; await monitor.tick();
  assert.equal(monitor.active.name, 'beta'); await turn();
  assert.deepEqual(requests, ['alpha', 'beta']);
  if (process.argv.includes('--ui-smoke')) {
    console.log('Opening synthetic native UI; exit with Ctrl-C without entering a prompt.');
    const ignoreInterrupt = () => {};
    process.on('SIGINT', ignoreInterrupt);
    try {
      const ui = spawn(codexBinary(), ['--remote', `unix://${socket}`, '--no-alt-screen', '-C', home, '--sandbox', 'read-only'], { env: codexEnv(home), stdio: 'inherit' });
      const code = await new Promise((resolve, reject) => { ui.once('error', reject); ui.once('exit', resolve); });
      assert.equal(code, 0);
      assert.deepEqual(requests, ['alpha', 'beta']);
      console.log('Native remote UI smoke passed (no additional model request).');
    } finally { process.off('SIGINT', ignoreInterrupt); }
  }
  for (const [dir, text] of originals) assert.equal(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'), text);
  assert.equal(fs.existsSync(path.join(home, 'auth.json')), false);
  console.log(JSON.stringify({ passed: true, sameThread: true, requestAccounts: requests, automaticQuotaTrigger: true, canonicalCredentialsUnchanged: true, runtimeCredentialsOnDisk: false }));
} catch (e) { console.error('Protocol verification failed:', e.message); process.exitCode = 1; }
finally {
  rpc?.close(); await monitor?.close();
  if (server.exitCode === null) { const exited = new Promise(r=>server.once('exit', r)); server.kill('SIGTERM'); const timer=setTimeout(()=>server.kill('SIGKILL'),3000); await exited; clearTimeout(timer); }
  upstream.closeAllConnections(); await new Promise(r=>upstream.close(r));
  console.log(`Synthetic scratch retained: ${root}`);
}
