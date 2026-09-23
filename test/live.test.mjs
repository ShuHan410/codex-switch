import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { Pool, Failure } from '../src/core.mjs';
import { LiveSwitch, SocketRpc } from '../src/live.mjs';

function fixture(t, values = { alpha: 80, beta: 60 }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-live-test-'));
  const pool = new Pool(path.join(root, 'pool')); const originals = new Map();
  for (const name of Object.keys(values)) {
    const home = path.join(root, name); fs.mkdirSync(home, { mode: 0o700 });
    const payload = Buffer.from(JSON.stringify({ sub: name, email: `${name}@example.test` })).toString('base64url');
    const auth = JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: `x.${payload}.x`, access_token: `access-${name}`, refresh_token: `refresh-${name}`, account_id: name } });
    fs.writeFileSync(path.join(home, 'auth.json'), auth, { mode: 0o600 });
    pool.add(name, home, true); originals.set(name, auth);
  }
  const limits = name => ({ rateLimits: { primary: { usedPercent: 100 - values[name], resetsAt: Date.now() / 1000 + 3600 } } });
  const events = []; const calls = []; let active;
  const rpc = { async request(method, params) {
    calls.push(method);
    if (method === 'account/login/start') { active = params.chatgptAccountId; return {}; }
    if (method === 'account/read') return { account: { type: 'chatgpt', email: `${active}@example.test` } };
    if (method === 'account/rateLimits/read') return limits(active);
    throw Error('Unexpected RPC');
  } };
  const probeAccount = async (_pool, name) => ({ ...pool.get(name), state: Number.isFinite(values[name]) && values[name] > 0 ? 'ready' : 'unknown', checkedAt: new Date().toISOString(), limits: limits(name) });
  const monitor = new LiveSwitch(pool, rpc, { probeAccount, record: value => events.push(value),
    refreshAccount: async account => ({ accessToken: `fresh-${account.name}`, chatgptAccountId: account.name }) });
  t.after(async () => { await monitor.close(); for (const [name, before] of originals) assert.equal(fs.readFileSync(path.join(pool.get(name).home, 'auth.json'), 'utf8'), before); fs.rmSync(root, { recursive: true, force: true }); });
  return { pool, rpc, monitor, values, events, calls };
}

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Reverse refresh deadlocked')), 500);
    })]);
  } finally { clearTimeout(timer); }
}

for (const callbackMethod of ['account/login/start', 'account/read']) {
  test(`reverse refresh during ${callbackMethod} uses the unconfirmed candidate without deadlock`, async t => {
    const f = fixture(t); const request = f.rpc.request.bind(f.rpc);
    const refreshed = []; let candidate;
    f.monitor.refreshAccount = async account => {
      assert.equal(f.monitor.active?.name, account.name === 'alpha' ? undefined : 'alpha');
      assert.throws(() => f.pool.accountLock(account.name), e => e instanceof Failure && e.state === 'busy');
      refreshed.push(account.name);
      return { accessToken: `fresh-${account.name}`, chatgptAccountId: account.name };
    };
    f.rpc.request = async (method, params) => {
      if (method === 'account/login/start') candidate = params.chatgptAccountId;
      if (method === callbackMethod) {
        const bundle = await bounded(f.rpc.refresh({ previousAccountId: candidate }));
        assert.equal(bundle.chatgptAccountId, candidate);
      }
      return request(method, params);
    };
    assert.equal(await f.monitor.pickAlternative(), true);
    assert.equal(await f.monitor.pickAlternative(), true);
    assert.equal(f.monitor.active.name, 'beta');
    assert.deepEqual(refreshed, ['alpha', 'beta']);
  });
}

test('an in-flight refresh finishes before another account login is submitted', async t => {
  const f = fixture(t); await f.monitor.pickAlternative();
  const order = []; const request = f.rpc.request.bind(f.rpc);
  f.rpc.request = (method, params) => {
    if (method === 'account/login/start') order.push('login');
    return request(method, params);
  };
  let release, started;
  const begun = new Promise(resolve => { started = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  f.monitor.refreshAccount = async account => {
    started(); await hold;
    return { accessToken: 'fresh-alpha', chatgptAccountId: account.name };
  };
  // Match SocketRpc's promise adoption before sending a reverse-RPC reply.
  const refresh = Promise.resolve().then(() => f.rpc.refresh({ previousAccountId: 'alpha' }))
    .then(result => { order.push('refresh reply'); return result; });
  f.rpc.drainControllerRequests = () => refresh;
  await begun;
  const switching = f.monitor.pickAlternative();
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.filter(method => method === 'account/login/start').length, 1);
  } finally { release(); }
  assert.equal((await refresh).chatgptAccountId, 'alpha');
  assert.equal(await switching, true);
  assert.equal(f.monitor.active.name, 'beta');
  assert.deepEqual(order, ['refresh reply', 'login']);
});

test('concurrent reverse refreshes are serialized while account confirmation waits', async t => {
  const f = fixture(t); const request = f.rpc.request.bind(f.rpc);
  let running = 0, peak = 0, completed = 0;
  f.monitor.refreshAccount = async account => {
    peak = Math.max(peak, ++running);
    await new Promise(resolve => setImmediate(resolve));
    running--; completed++;
    return { accessToken: `fresh-${completed}`, chatgptAccountId: account.name };
  };
  f.rpc.request = async (method, params) => {
    if (method === 'account/read') await bounded(Promise.all([
      f.rpc.refresh({ previousAccountId: 'alpha' }),
      f.rpc.refresh({ previousAccountId: 'alpha' }),
    ]));
    return request(method, params);
  };
  assert.equal(await f.monitor.pickAlternative(), true);
  assert.equal(completed, 2); assert.equal(peak, 1);
});

test('a wrong-account refresh is rejected and a resulting confirmation failure pauses activation', async t => {
  const f = fixture(t); const request = f.rpc.request.bind(f.rpc);
  f.monitor.refreshAccount = async () => ({ accessToken: 'wrong-account-token', chatgptAccountId: 'beta' });
  f.rpc.request = async (method, params) => {
    if (method === 'account/read') await bounded(f.rpc.refresh({ previousAccountId: 'alpha' }));
    return request(method, params);
  };
  await assert.rejects(f.monitor.pickAlternative(), /unexpected identity/);
  assert.equal(f.monitor.active, null);
  assert.equal(f.monitor.halted, true);
});

test('socket controller sends the old refresh reply before the next login', async t => {
  const f = fixture(t); const server = http.createServer();
  const socket = path.join(f.pool.root, 'test.sock');
  const wss = new WebSocketServer({ server });
  let active, connection, release, started, replyReceived;
  const order = [];
  const begun = new Promise(resolve => { started = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const replied = new Promise(resolve => { replyReceived = resolve; });
  wss.on('connection', ws => {
    connection = ws;
    ws.on('message', data => {
      const msg = JSON.parse(data.toString());
      if (msg.id === 9001 && !msg.method) { order.push('refresh reply'); replyReceived(); return; }
      if (msg.id === undefined) return;
      let result = {};
      if (msg.method === 'account/login/start') {
        active = msg.params.chatgptAccountId;
        if (active === 'beta') order.push('login');
      }
      if (msg.method === 'account/read') result = { account: { type: 'chatgpt', email: `${active}@example.test` } };
      ws.send(JSON.stringify({ id: msg.id, result }));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  const rpc = new SocketRpc(socket, 1000);
  const monitor = new LiveSwitch(f.pool, rpc, {
    probeAccount: f.monitor.probeAccount,
    refreshAccount: async account => {
      started(); await hold;
      return { accessToken: 'synthetic-refreshed', chatgptAccountId: account.name };
    },
  });
  try {
    await rpc.initialize(); await monitor.pickAlternative();
    connection.send(JSON.stringify({ id: 9001, method: 'account/chatgptAuthTokens/refresh', params: { previousAccountId: 'alpha' } }));
    await bounded(begun);
    const switching = monitor.pickAlternative();
    await new Promise(resolve => setImmediate(resolve));
    release();
    await bounded(Promise.all([switching, replied]));
    assert.equal(monitor.active.name, 'beta');
    assert.deepEqual(order, ['refresh reply', 'login']);
  } finally {
    release(); rpc.close(); await monitor.close();
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
});

test('confirmation failure after rejected refresh pauses activation and retains candidate lease', async t => {
  const f = fixture(t); const request = f.rpc.request.bind(f.rpc);
  f.monitor.refreshAccount = async () => { throw Error('Synthetic refresh failure'); };
  f.rpc.request = async (method, params) => {
    if (method === 'account/read') await bounded(f.rpc.refresh({ previousAccountId: 'alpha' }));
    return request(method, params);
  };
  await assert.rejects(f.monitor.pickAlternative(), /Synthetic refresh failure/);
  assert.equal(f.monitor.active, null);
  assert.equal(f.monitor.halted, true);
  assert.throws(() => f.pool.accountLock('alpha'), e => e instanceof Failure && e.state === 'busy');
});

test('close waits for refresh work and rejects its late credentials before releasing leases', async t => {
  const f = fixture(t); await f.monitor.pickAlternative();
  let release, started;
  const begun = new Promise(resolve => { started = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  f.monitor.refreshAccount = async account => {
    started(); await hold;
    return { accessToken: 'late-token', chatgptAccountId: account.name };
  };
  const rejected = assert.rejects(f.rpc.refresh({ previousAccountId: 'alpha' }), /No active managed account|Account refresh/);
  await begun;
  const closing = f.monitor.close();
  try {
    assert.throws(() => f.pool.accountLock('alpha'), e => e instanceof Failure && e.state === 'busy');
  } finally { release(); }
  await rejected; await closing;
  const unlock = f.pool.accountLock('alpha'); unlock();
});

test('ambiguous same-email workspace identities are not activated', async t => {
  const f = fixture(t);
  f.pool.save({ ...f.pool.get('beta'), email: f.pool.get('alpha').email });
  assert.equal(await f.monitor.pickAlternative(), false);
  assert.equal(f.calls.includes('account/login/start'), false);
  for (const name of f.pool.names()) { const release = f.pool.accountLock(name); release(); }
});

test('live quota threshold changes current backend account without restarting a process', async t => {
  const f = fixture(t); assert.equal(await f.monitor.pickAlternative(), true);
  assert.equal(f.monitor.active.name, 'alpha');
  f.values.alpha = 5; await f.monitor.tick();
  assert.equal(f.monitor.active.name, 'beta');
  assert.equal(f.calls.filter(m => m === 'account/login/start').length, 2);
  const release = f.pool.accountLock('alpha'); release();
  assert.throws(() => f.pool.accountLock('beta'), e => e instanceof Failure && e.state === 'busy');
});
test('exact threshold stays on active account and unknown quota never triggers a switch', async t => {
  const f = fixture(t); await f.monitor.pickAlternative();
  f.values.alpha = 10; await f.monitor.tick(); assert.equal(f.monitor.active.name, 'alpha');
  f.values.alpha = NaN; await f.monitor.tick(); assert.equal(f.monitor.active.name, 'alpha');
  assert.equal(f.calls.filter(m => m === 'account/login/start').length, 1);
});
test('no eligible alternative keeps the conversation and records no-alternative', async t => {
  const f = fixture(t); await f.monitor.pickAlternative();
  f.values.alpha = 0; f.values.beta = 2; await f.monitor.tick();
  assert.equal(f.monitor.active.name, 'alpha'); assert.equal(f.events.at(-1).state, 'no-alternative');
});
test('busy alternatives are skipped and refresh replies are bound to current active identity', async t => {
  const f = fixture(t); await f.monitor.pickAlternative();
  const release = f.pool.accountLock('beta');
  f.values.alpha = 3; await f.monitor.tick(); assert.equal(f.monitor.active.name, 'alpha'); release();
  assert.equal((await f.rpc.refresh({ previousAccountId: 'alpha' })).accessToken, 'fresh-alpha');
  assert.equal((await f.rpc.refresh({ previousAccountId: 'old' })).chatgptAccountId, 'alpha');
});
test('ambiguous activation failure pauses switching and retains credential leases until close', async t => {
  const f = fixture(t); await f.monitor.pickAlternative(); const request = f.rpc.request;
  f.rpc.request = async (method, params) => { if (method === 'account/login/start') throw Error('timeout'); return request(method, params); };
  f.values.alpha = 1; await f.monitor.tick(); assert.equal(f.monitor.halted, true);
  assert.equal(f.events.at(-1).state, 'paused');
  assert.throws(() => f.pool.accountLock('alpha'));
  assert.throws(() => f.pool.accountLock('beta'));
});
test('external account changes halt monitoring without overwriting pool credentials', async t => {
  const f = fixture(t); await f.monitor.pickAlternative(); const request = f.rpc.request;
  f.rpc.request = async (method, params) => method === 'account/read' ? { account: { type: 'chatgpt', email: 'other@example.test' } } : request(method, params);
  await f.monitor.tick(); assert.equal(f.monitor.halted, true); assert.equal(f.events.at(-1).state, 'paused');
});
test('overlapping ticks are coalesced and an unhealthy rechecked candidate is not activated', async t => {
  const f = fixture(t); await f.monitor.pickAlternative(); f.values.alpha = 3;
  const original = f.monitor.probeAccount;
  f.monitor.probeAccount = async (pool, name, options) => {
    const result = await original(pool, name);
    return options?.locked ? { ...result, state: 'unknown' } : result;
  };
  await Promise.all([f.monitor.tick(), f.monitor.tick(), f.monitor.tick()]);
  assert.equal(f.monitor.active.name, 'alpha');
  assert.equal(f.calls.filter(m => m === 'account/rateLimits/read').length, 1);
});
