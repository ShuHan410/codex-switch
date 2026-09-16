import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { Pool, probe } from '../src/core.mjs';
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

test('removed names can be reused without overwriting retained homes', t => {
  const f = fixture(t);
  const retained = path.join(f.pool.dir('alpha'), 'codex-home');
  writeAuth(retained, authBytes('retained'));
  f.pool.remove('alpha');
  const destination = f.pool.newHome('alpha');
  assert.notEqual(destination, retained);
  const stage = path.join(f.root, 'reuse-stage'); writeAuth(stage, authBytes('replacement'));
  f.pool.add('alpha', stage, true, { destination });
  assert.equal(fs.readFileSync(path.join(retained, 'auth.json'), 'utf8'), authBytes('retained'));
  assert.equal(f.pool.get('alpha').home, destination);
});

test('probe cannot resurrect a removed record and stale snapshots reject name reuse', async t => {
  const f = fixture(t); const old = f.pool.get('alpha');
  const acquire = f.pool.accountLock.bind(f.pool);
  f.pool.accountLock = name => {
    f.pool.accountLock = acquire;
    f.pool.remove(name);
    return acquire(name);
  };
  await assert.rejects(probe(f.pool, 'alpha'));
  assert.deepEqual(f.pool.names(), ['beta']);
  f.pool.rename('beta', 'alpha');
  assert.throws(() => f.pool.revalidate(old), /registration changed/);
});

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

test('usage prints remaining percentages instead of used', t => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [cli, 'usage', '--all'], { env: { ...cliEnv(f), TZ: 'Asia/Taipei' }, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /4% left/); assert.match(result.stdout, /80% left/);
  assert.doesNotMatch(result.stdout, /% used/);
  assert.match(result.stdout, /ACCOUNT\s+PLAN\s+STATUS/);
  assert.match(result.stdout, /\n    Checked: /);
  assert.match(result.stdout, /\n      Resets: /);
  assert.match(result.stdout, /Checked: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+08:00/);
  assert.match(result.stdout, /Resets: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+08:00/);
  assert.match(result.stdout, /\[LOW <5%\]/); assert.match(result.stdout, /\[OK\]/);
  assert.doesNotMatch(result.stdout, /\x1b\[/);
});

test('usage --all queries at most two accounts concurrently and preserves account order', t => {
  const f = fixture(t); const rpcLog = path.join(f.root, 'rpc.log');
  for (const name of ['gamma', 'delta']) {
    const home = path.join(f.root, `managed-${name}`); writeAuth(home, authBytes(name));
    f.pool.add(name, home, true);
  }
  const env = { ...cliEnv(f), CODEX_SWITCH_TEST_RPC_DELAY: '40', CODEX_SWITCH_TEST_RPC_LOG: rpcLog,
    CODEX_SWITCH_TEST_REMAINING_BY_SUB: JSON.stringify({ alpha: 4, beta: 80, gamma: 60, delta: 40 }) };
  const result = spawnSync(process.execPath, [cli, 'usage', '--all', '--json'], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).map(a => a.name), ['alpha', 'beta', 'delta', 'gamma']);
  const events = fs.readFileSync(rpcLog, 'utf8').trim().split('\n').map(JSON.parse);
  let active = 0; let peak = 0;
  for (const event of events) {
    active += event.phase === 'start' ? 1 : -1;
    assert.ok(active >= 0); peak = Math.max(peak, active);
  }
  assert.equal(active, 0); assert.equal(peak, 2);
  assert.equal(new Set(events.map(event => event.home)).size, 4);
});

test('display distinguishes native and run default, escapes controls, and keeps JSON clean', t => {
  const f = fixture(t); f.pool.select('beta');
  f.pool.save({ ...f.pool.get('beta'), email: 'beta\x1b[31m@example.test', error: 'line\nbreak', checkedAt: '2026-09-16T06:19:40.471Z' });
  const run = args => spawnSync(process.execPath, [cli, ...args], { env: cliEnv(f), encoding: 'utf8', timeout: 5000 });
  const text = run(['list']); assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Run default: beta/);
  assert.match(text.stdout, /^\* alpha /m);
  assert.match(text.stdout, /Note: line\?break/);
  assert.doesNotMatch(text.stdout, /\x1b/);
  const json = run(['list', '--json']); assert.equal(json.status, 0, json.stderr);
  const rows = JSON.parse(json.stdout);
  assert.equal(rows[0].active, true); assert.equal(rows[1].selected, true);
  assert.equal(rows[1].email, 'beta\x1b[31m@example.test');
  assert.equal(rows[1].error, 'line\nbreak');
  assert.equal(rows[1].checkedAt, '2026-09-16T06:19:40.471Z');
  f.pool.remove('alpha'); f.pool.remove('beta');
  const empty = run(['list']); assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /codex-switch import NAME/);
  assert.match(empty.stdout, /codex-switch login NAME/);
  assert.deepEqual(JSON.parse(run(['list', '--json']).stdout), []);
});

test('rename updates label and default without moving credentials; removal unregisters without logout', t => {
  const f = fixture(t);
  const run = args => spawnSync(process.execPath, [cli, ...args], { env: cliEnv(f), encoding: 'utf8', timeout: 5000 });
  let result = run(['rename', 'alpha', 'adam']); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.pool.names(), ['adam', 'beta']); assert.equal(f.pool.selected(), 'adam');
  assert.equal(f.pool.get('adam').home, f.homes.alpha);
  assert.equal(fs.readFileSync(path.join(f.homes.alpha, 'auth.json'), 'utf8'), f.canonical.alpha);
  assert.match(run(['list']).stdout, /^\* adam /m);
  result = run(['remove', 'adam']); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.pool.names(), ['beta']); assert.equal(f.pool.selected(), undefined);
  assert.equal(fs.readFileSync(path.join(f.native, 'auth.json'), 'utf8'), f.nativeBefore);
  assert.equal(fs.readFileSync(path.join(f.homes.alpha, 'auth.json'), 'utf8'), f.canonical.alpha);
  assert.match(run(['list']).stdout, /unregistered/);
  const archive = fs.readdirSync(path.join(f.pool.root, 'removed'));
  assert.equal(archive.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.pool.root, 'removed', archive[0]))).name, 'adam');
});

test('rename/remove reject busy accounts, collisions and invalid names without losing records', t => {
  const f = fixture(t);
  assert.throws(() => f.pool.rename('alpha', 'beta'));
  assert.throws(() => f.pool.rename('alpha', '../bad'));
  const release = f.pool.accountLock('alpha');
  try { assert.throws(() => f.pool.rename('alpha', 'adam')); assert.throws(() => f.pool.remove('alpha')); }
  finally { release(); }
  assert.deepEqual(f.pool.names(), ['alpha', 'beta']); assert.equal(f.pool.selected(), 'alpha');
  assert.throws(() => f.pool.remove('missing'));
});

test('use changes native auth and selection, preserves history, and saves outgoing credentials', t => {
  const f = fixture(t);
  fs.chmodSync(f.native, 0o775);
  const result = spawnSync(process.execPath, [cli, 'use', 'beta'], { env: cliEnv(f), encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.statSync(f.native).mode & 0o777, 0o755);
  assert.match(result.stdout, /Native login set to beta/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.native, 'auth.json'))), JSON.parse(f.canonical.beta));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.homes.alpha, 'auth.json'))), JSON.parse(f.nativeBefore));
  assert.equal(f.pool.selected(), 'beta');
  for (const [file, before] of f.untouched) assert.deepEqual(fs.readFileSync(path.join(f.native, file)), before);
  assert.equal(fs.statSync(path.join(f.native, 'auth.json')).mode & 0o777, 0o600);
  assert.ok(files(path.join(f.pool.root, 'auto/backups')).some(file => JSON.stringify(JSON.parse(fs.readFileSync(file))) === f.nativeBefore));
  assert.equal(fs.existsSync(path.join(f.native, '.codex-switch-auto.lock')), false);
});

test('list and usage identify native login independently of selection and follow external changes', t => {
  const f = fixture(t); f.pool.select('beta');
  fs.chmodSync(f.native, 0o775);
  for (const args of [['list'], ['usage', '--all']]) {
    const invoke = extra => spawnSync(process.execPath, [cli, ...args, ...extra], { env: cliEnv(f), encoding: 'utf8', timeout: 10000 });
    writeAuth(f.native, f.nativeBefore);
    let result = invoke([]); assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^\* alpha /m); assert.doesNotMatch(result.stdout, /^\* beta /m);
    const initialRows = JSON.parse(invoke(['--json']).stdout);
    assert.deepEqual(initialRows.filter(a => a.active).map(a => a.name), ['alpha']);
    assert.deepEqual(initialRows.filter(a => a.selected).map(a => a.name), ['beta']);
    assert.ok(initialRows.every(a => a.nativeState === 'registered'));
    writeAuth(f.native, authBytes('outsider'));
    result = invoke([]); assert.match(result.stdout, /outsider@example.test \(unregistered\)/);
    assert.doesNotMatch(result.stdout, /^\* /m);
    const outsiderRows = JSON.parse(invoke(['--json']).stdout);
    assert.ok(outsiderRows.every(a => !a.active && a.nativeState === 'unregistered'));
    writeAuth(f.native, f.canonical.beta);
    result = invoke(['--json']);
    const rows = JSON.parse(result.stdout);
    assert.deepEqual(rows.filter(a => a.active).map(a => a.name), ['beta']);
    assert.equal(f.pool.selected(), 'beta');
    fs.unlinkSync(path.join(f.native, 'auth.json'));
    result = invoke([]); assert.match(result.stdout, /signed-out/); assert.doesNotMatch(result.stdout, /^\* /m);
    writeAuth(f.native, '{invalid');
    result = invoke([]); assert.match(result.stdout, /unknown/); assert.doesNotMatch(result.stdout, /^\* /m);
    result = invoke(['--codex-home', f.homes.beta]);
    assert.match(result.stdout, /^\* beta /m);
    assert.equal(fs.statSync(f.native).mode & 0o777, 0o775);
  }
});

test('use still rejects a symlinked native home without changing its permissions or credentials', t => {
  const f = fixture(t); const linked = path.join(f.root, 'linked');
  fs.chmodSync(f.native, 0o775); fs.symlinkSync(f.native, linked);
  const result = spawnSync(process.execPath, [cli, 'use', 'beta', '--codex-home', linked], { env: cliEnv(f), encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1);
  assert.equal(fs.statSync(f.native).mode & 0o777, 0o775);
  assert.equal(fs.readFileSync(path.join(f.native, 'auth.json'), 'utf8'), f.nativeBefore);
  assert.equal(f.pool.selected(), 'alpha');
});

test('use on the active account does not restore its older pool credentials', t => {
  const f = fixture(t); f.pool.select('beta');
  const result = spawnSync(process.execPath, [cli, 'use', 'alpha'], { env: cliEnv(f), encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(f.native, 'auth.json'), 'utf8'), f.nativeBefore);
  assert.equal(f.pool.selected(), 'alpha');
});

test('use supports an unregistered or absent native login and refuses a monitor lock', t => {
  const f = fixture(t); const outsider = authBytes('outsider'); writeAuth(f.native, outsider);
  const args = [cli, 'use', 'beta', '--codex-home', f.native];
  let result = spawnSync(process.execPath, args, { env: cliEnv(f), encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(files(path.join(f.pool.root, 'auto/backups')).some(file => JSON.stringify(JSON.parse(fs.readFileSync(file))) === outsider));
  fs.unlinkSync(path.join(f.native, 'auth.json'));
  result = spawnSync(process.execPath, args, { env: cliEnv(f), encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const before = fs.readFileSync(path.join(f.native, 'auth.json'));
  fs.mkdirSync(path.join(f.native, '.codex-switch-auto.lock'));
  result = spawnSync(process.execPath, [cli, 'use', 'alpha'], { env: cliEnv(f), encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 3);
  assert.deepEqual(fs.readFileSync(path.join(f.native, 'auth.json')), before);
  assert.equal(f.pool.selected(), 'beta');
});

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
