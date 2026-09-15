import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool, Failure } from '../src/core.mjs';
import { LiveSwitch } from '../src/live.mjs';

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
