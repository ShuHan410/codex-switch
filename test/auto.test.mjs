import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { Pool } from '../src/core.mjs';
import { NativeAuto } from '../src/auto.mjs';

const future = () => Date.now() / 1000 + 3600;

function jwt(sub) {
  return `header.${Buffer.from(JSON.stringify({ sub, email: `${sub}@example.test` })).toString('base64url')}.signature`;
}

function authBytes(sub, marker = sub) {
  return JSON.stringify({ auth_mode: 'chatgpt', tokens: {
    refresh_token: `refresh-${marker}`, access_token: `access-${marker}`,
    id_token: jwt(sub), account_id: `account-${sub}`,
  } });
}

function writeAuth(home, bytes) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, 'auth.json'), bytes, { mode: 0o600 });
  fs.chmodSync(path.join(home, 'auth.json'), 0o600);
}

function limits(remaining) {
  return { rateLimits: { primary: { usedPercent: 100 - remaining, resetsAt: future() } } };
}

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}

function fixture(t, { alpha = 4, beta = 80, betaManaged = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-auto-test-'));
  const pool = new Pool(path.join(root, 'pool'));
  const native = path.join(root, 'native');
  const homes = Object.fromEntries(['alpha', 'beta'].map(name => [name, path.join(root, `managed-${name}`)]));
  const canonical = { alpha: authBytes('alpha', 'canonical-alpha'), beta: authBytes('beta', 'canonical-beta') };
  writeAuth(homes.alpha, canonical.alpha); writeAuth(homes.beta, canonical.beta);
  pool.add('alpha', homes.alpha, true); pool.add('beta', homes.beta, betaManaged);
  const nativeBefore = authBytes('alpha', 'native-alpha'); writeAuth(native, nativeBefore);
  fs.writeFileSync(path.join(native, 'config.toml'), 'model = "keep-me"\n', { mode: 0o600 });
  fs.writeFileSync(path.join(native, 'history.jsonl'), '{"keep":"history"}\n', { mode: 0o600 });
  const untouched = new Map(['config.toml', 'history.jsonl'].map(file => [file, fs.readFileSync(path.join(native, file))]));
  const values = { alpha, beta }; const calls = []; const events = [];
  let onProbe;
  const probeAccount = async (seenPool, name, options = {}) => {
    const entry = seenPool.get(name);
    calls.push({ name, home: entry.home, locked: Boolean(options.locked) });
    await onProbe?.({ seenPool, name, options, entry });
    const remaining = values[name];
    const result = { ...entry, state: Number.isFinite(remaining) && remaining > 0 ? 'ready' : remaining === 0 ? 'limited' : 'unknown',
      limits: Number.isFinite(remaining) ? limits(remaining) : undefined, checkedAt: new Date().toISOString(), error: undefined };
    seenPool.save(result); // Match core.probe: health is persisted through the supplied pool.
    return result;
  };
  const auto = new NativeAuto(pool, native, { probeAccount, record: value => events.push(value) });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root, pool, native, homes, canonical, nativeBefore, untouched, values, calls, events, auto,
    set onProbe(value) { onProbe = value; },
  };
}

test('polls the native-home identity and rotates credentials without touching native settings', async t => {
  const f = fixture(t); f.pool.select('beta'); // The native file, not this pointer, is authoritative.
  await f.auto.tick();

  assert.deepEqual(f.calls.map(call => call.name), ['alpha', 'beta', 'beta']);
  assert.equal(f.calls[0].home, f.native);
  assert.equal(f.calls[1].home, f.homes.beta);
  assert.equal(f.calls[2].locked, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.native, 'auth.json'), 'utf8')), JSON.parse(f.canonical.beta));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.homes.alpha, 'auth.json'), 'utf8')), JSON.parse(f.nativeBefore));
  assert.equal(f.pool.get('alpha').home, fs.realpathSync(f.homes.alpha));
  assert.equal(f.pool.selected(), 'beta');
  for (const [file, before] of f.untouched) assert.deepEqual(fs.readFileSync(path.join(f.native, file)), before);
  const backup = files(path.join(f.pool.root, 'auto', 'backups')).find(file => JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8'))) === f.nativeBefore);
  assert.ok(backup, 'outgoing native auth is backed up before replacement');
  assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
  assert.equal(f.events.at(-1).state, 'switched');
  assert.equal(fs.statSync(path.join(f.native, 'auth.json')).mode & 0o777, 0o600);
  f.calls.length = 0;
  await f.auto.tick();
  assert.deepEqual(f.calls.map(call => [call.name, call.home]), [['beta', f.native]]);
});

test('at exactly five percent it remains on the active native account', async t => {
  const f = fixture(t, { alpha: 5 });
  await f.auto.tick();
  assert.equal(fs.readFileSync(path.join(f.native, 'auth.json'), 'utf8'), f.nativeBefore);
  assert.deepEqual(f.calls.map(call => call.name), ['alpha']);
  assert.equal(f.pool.selected(), 'alpha');
});

test('an unregistered native identity is fail-closed even when a selected account exists', async t => {
  const f = fixture(t); const outsider = authBytes('outsider', 'native-outsider');
  writeAuth(f.native, outsider); f.pool.select('beta');
  await f.auto.tick();
  assert.equal(fs.readFileSync(path.join(f.native, 'auth.json'), 'utf8'), outsider);
  assert.deepEqual(f.calls, []);
  assert.equal(f.pool.selected(), 'beta');
});

test('only managed alternatives qualify; no viable managed alternative leaves native auth intact', async t => {
  const f = fixture(t, { betaManaged: false });
  await f.auto.tick();
  assert.equal(fs.readFileSync(path.join(f.native, 'auth.json'), 'utf8'), f.nativeBefore);
  assert.deepEqual(f.calls.map(call => call.name), ['alpha']);
  assert.equal(f.pool.selected(), 'alpha');
});

test('a busy candidate is skipped without a native credential write', async t => {
  const f = fixture(t);
  const release = f.pool.accountLock('beta');
  try { await f.auto.tick(); } finally { release(); }
  assert.equal(fs.readFileSync(path.join(f.native, 'auth.json'), 'utf8'), f.nativeBefore);
  assert.equal(f.pool.selected(), 'alpha');
  assert.ok(f.calls.some(call => call.name === 'beta'));
});

test('unknown current quota and exhausted alternatives never trigger a write', async t => {
  const f = fixture(t, { alpha: NaN });
  await f.auto.tick();
  assert.equal(f.events.at(-1).state, 'unknown');
  assert.equal(f.calls.length, 1);
  f.values.alpha = 0; f.values.beta = 0;
  await f.auto.tick();
  assert.equal(f.events.at(-1).state, 'no-alternative');
  assert.equal(fs.readFileSync(path.join(f.native, 'auth.json'), 'utf8'), f.nativeBefore);
});

test('external native auth changes during alternative probing cancel the pending replacement', async t => {
  const f = fixture(t); const external = authBytes('outsider', 'external-change');
  let changed = false;
  f.onProbe = async ({ name, options }) => {
    if (name === 'beta' && !options.locked && !changed) { changed = true; writeAuth(f.native, external); }
  };
  await f.auto.tick();
  assert.equal(fs.readFileSync(path.join(f.native, 'auth.json'), 'utf8'), external);
  assert.equal(f.pool.selected(), 'alpha');
  assert.equal(fs.existsSync(path.join(f.pool.root, 'auto', 'backups')), false);
});

test('a candidate whose credential identity changes before locked recheck is refused', async t => {
  const f = fixture(t); const changed = authBytes('outsider', 'candidate-external');
  f.onProbe = async ({ name, options }) => {
    if (name === 'beta' && options.locked) writeAuth(f.homes.beta, changed);
  };
  await f.auto.tick();
  assert.equal(fs.readFileSync(path.join(f.native, 'auth.json'), 'utf8'), f.nativeBefore);
  assert.equal(f.pool.selected(), 'alpha');
});

test('a native change during backup work preserves both the new native login and canonical credentials', async t => {
  const f = fixture(t); const external = authBytes('outsider', 'during-backup');
  const backup = f.auto.backup.bind(f.auto);
  f.auto.backup = snapshot => { backup(snapshot); writeAuth(f.native, external); };
  await f.auto.tick();
  assert.equal(fs.readFileSync(path.join(f.native, 'auth.json'), 'utf8'), external);
  assert.equal(fs.readFileSync(path.join(f.homes.alpha, 'auth.json'), 'utf8'), f.canonical.alpha);
  assert.equal(f.pool.selected(), 'alpha');
  assert.equal(f.events.at(-1).state, 'changed');
});

test('overlapping ticks coalesce into one native poll, and closed polling is inert', async t => {
  const f = fixture(t, { alpha: 5 });
  let release; const gate = new Promise(resolve => { release = resolve; });
  f.onProbe = async ({ name }) => { if (name === 'alpha') await gate; };
  const ticks = [f.auto.tick(), f.auto.tick(), f.auto.tick()];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 1);
  release(); await Promise.all(ticks);
  assert.equal(f.calls.length, 1);
  f.auto.closed = true; await f.auto.tick();
  assert.equal(f.calls.length, 1);
});

const cli = path.resolve(import.meta.dirname, '../bin/codex-switch.mjs');
const fakeCodex = path.resolve(import.meta.dirname, 'fixtures/fake-codex');
function cliEnv(f) {
  return { ...process.env, CODEX_SWITCH_HOME: f.pool.root, CODEX_HOME: f.native,
    CODEX_SWITCH_CODEX: fakeCodex, CODEX_SWITCH_TEST_REMAINING_BY_SUB: JSON.stringify({ alpha: 4, beta: 80 }) };
}

test('auto --once wires native quota probes to file replacement and status without session launch', t => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [cli, 'auto', '--once'], { env: cliEnv(f), encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.native, 'auth.json'))), JSON.parse(f.canonical.beta));
  const status = JSON.parse(fs.readFileSync(path.join(f.pool.root, 'auto/status.json')));
  assert.equal(status.lastState, 'switched'); assert.equal(status.state, 'stopped');
  assert.equal(status.minRemaining, 5); assert.equal(status.interval, 30);
  assert.equal(fs.existsSync(path.join(f.native, '.codex-switch-auto.lock')), false);
  const viewed = spawnSync(process.execPath, [cli, 'status', '--auto'], { env: cliEnv(f), encoding: 'utf8' });
  assert.equal(viewed.status, 0); assert.match(viewed.stdout, /Native auto: stopped; account=beta/);
});

test('auto holds a singleton lock and SIGTERM releases monitor and native locks', async t => {
  const f = fixture(t); writeAuth(f.native, authBytes('unregistered'));
  const child = spawn(process.execPath, [cli, 'auto'], { env: cliEnv(f), stdio: 'ignore' });
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const statusFile = path.join(f.pool.root, 'auto/status.json');
  for (let i = 0; i < 100 && !fs.existsSync(statusFile); i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(fs.existsSync(statusFile), true);
  const duplicate = spawnSync(process.execPath, [cli, 'auto', '--once'], { env: cliEnv(f), encoding: 'utf8', timeout: 5000 });
  assert.equal(duplicate.status, 3);
  child.kill('SIGTERM'); assert.equal(await done, 0);
  assert.equal(fs.existsSync(path.join(f.pool.root, 'auto/.lock')), false);
  assert.equal(fs.existsSync(path.join(f.native, '.codex-switch-auto.lock')), false);
});
