import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  Failure, Pool, Rpc, choose, credentialIdentity, headroom, lock, mapConcurrent, nameCheck,
} from '../src/core.mjs';
import { main } from '../src/main.mjs';

const tool = path.resolve(import.meta.dirname, '..');
const fakeCodex = path.join(tool, 'test', 'fixtures', 'fake-codex');
const future = Date.now() / 1000 + 3600;
const originalEnv = { ...process.env };
const tempRoots = [];

function temp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-switch-test-'));
  tempRoots.push(root);
  return root;
}
function jwt(sub, email = `${sub}@example.test`) {
  return `header.${Buffer.from(JSON.stringify({ sub, email })).toString('base64url')}.signature`;
}
function auth(home, sub, accountId = `account-${sub}`, mode = 0o600) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: {
    refresh_token: `refresh-${sub}`, access_token: `access-${sub}`, id_token: jwt(sub), account_id: accountId,
  } }), { mode });
  fs.chmodSync(path.join(home, 'auth.json'), mode);
}
function resetEnv() {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  process.exitCode = undefined;
}
function capturedMain(argv) {
  const out = []; const err = [];
  const log = console.log; const error = console.error;
  console.log = (...v) => out.push(v.join(' '));
  console.error = (...v) => err.push(v.join(' '));
  return main(argv).then(() => ({ out, err, code: process.exitCode ?? 0 })).finally(() => {
    console.log = log; console.error = error;
  });
}
function account(name, remaining, state = 'ready', checkedAt = new Date().toISOString()) {
  return { name, state, checkedAt, limits: { rateLimits: { primary: { usedPercent: 100 - remaining, resetsAt: future } } } };
}

test('bounded mapping runs two tasks at a time and preserves input order', async () => {
  const started = []; const releases = new Map(); let active = 0; let peak = 0;
  const pending = mapConcurrent(['alpha', 'beta', 'gamma', 'delta'], 2, async name => {
    started.push(name); active++; peak = Math.max(peak, active);
    await new Promise(resolve => releases.set(name, resolve));
    active--; return name.toUpperCase();
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['alpha', 'beta']); assert.equal(peak, 2);
  releases.get('beta')(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['alpha', 'beta', 'gamma']);
  releases.get('alpha')(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['alpha', 'beta', 'gamma', 'delta']);
  releases.get('gamma')(); releases.get('delta')();
  assert.deepEqual(await pending, ['ALPHA', 'BETA', 'GAMMA', 'DELTA']);
  assert.equal(peak, 2);
});

test('bounded mapping drains active tasks before reporting an error', async () => {
  const expected = new Error('query failed'); let release; let settled = false;
  const blocker = new Promise(resolve => { release = resolve; });
  const pending = mapConcurrent(['slow', 'failed'], 2, async name => {
    if (name === 'slow') await blocker;
    else throw expected;
  });
  pending.finally(() => { settled = true; }).catch(() => {});
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  release(); await assert.rejects(pending, error => error === expected);
  assert.equal(settled, true);
});
test.after(() => {
  resetEnv();
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

test('import snapshots current login into managed storage and supports later login renewal', { concurrency: false }, async () => {
  resetEnv(); const root = temp(); const source = path.join(root, 'source'); auth(source, 'imported');
  process.env.CODEX_HOME = source; process.env.CODEX_SWITCH_HOME = path.join(root, 'pool');
  process.env.CODEX_SWITCH_CODEX = fakeCodex;
  process.env.CODEX_SWITCH_TEST_LOG = path.join(root, 'native.log');
  fs.writeFileSync(path.join(source, 'config.toml'), 'model = "fixture-model"\n');
  const before = fs.readFileSync(path.join(source, 'auth.json'), 'utf8');
  const result = await capturedMain(['import', 'saved']); assert.equal(result.code, 0);
  assert.equal(fs.existsSync(process.env.CODEX_SWITCH_TEST_LOG), false);
  const pool = new Pool(); const saved = pool.get('saved');
  assert.equal(saved.managed, true); assert.equal(saved.state, 'unchecked');
  assert.notEqual(saved.home, source);
  assert.equal(fs.readFileSync(path.join(saved.home, 'auth.json'), 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(source, 'auth.json'), 'utf8'), before);
  assert.equal(fs.statSync(path.join(saved.home, 'auth.json')).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(saved.home, 'config.toml'), 'utf8'), 'model = "fixture-model"\n');
  auth(source, 'another');
  assert.equal(credentialIdentity(saved.home).identity, saved.identity);
  process.env.CODEX_SWITCH_TEST_LOGIN_SUB = 'imported';
  assert.equal((await capturedMain(['login', 'saved'])).code, 0);
  assert.equal(credentialIdentity(source).email, 'another@example.test');
  resetEnv();
});

test('duplicate import preserves original managed credentials and removes staging files', { concurrency: false }, async () => {
  resetEnv(); const root = temp(); const source = path.join(root, 'source'); auth(source, 'duplicate');
  process.env.CODEX_SWITCH_HOME = path.join(root, 'pool');
  assert.equal((await capturedMain(['import', 'first', '--source-home', source])).code, 0);
  const pool = new Pool(); const before = fs.readFileSync(path.join(pool.get('first').home, 'auth.json'), 'utf8');
  assert.equal((await capturedMain(['import', 'other', '--source-home', source])).code, 1);
  assert.deepEqual(pool.names(), ['first']);
  assert.deepEqual(fs.readdirSync(pool.dir('other')), []);
  assert.equal(fs.readFileSync(path.join(pool.get('first').home, 'auth.json'), 'utf8'), before);
  auth(source, 'different'); process.exitCode = undefined;
  assert.equal((await capturedMain(['import', 'first', '--source-home', source])).code, 1);
  assert.equal(fs.readFileSync(path.join(pool.get('first').home, 'auth.json'), 'utf8'), before);
  resetEnv();
});

test('import refuses insecure credentials without registering or leaving a copied token', { concurrency: false }, async () => {
  resetEnv(); const root = temp(); const source = path.join(root, 'source'); auth(source, 'unsafe', 'id', 0o644);
  process.env.CODEX_SWITCH_HOME = path.join(root, 'pool');
  assert.equal((await capturedMain(['import', 'unsafe', '--source-home', source])).code, 1);
  const pool = new Pool(); assert.deepEqual(pool.names(), []);
  assert.deepEqual(fs.readdirSync(pool.dir('unsafe')), []);
  assert.equal(fs.statSync(path.join(source, 'auth.json')).mode & 0o777, 0o644);
  resetEnv();
});

test('names reject traversal and pool rejects duplicate credential identities', { concurrency: false }, () => {
  const root = temp(); const one = path.join(root, 'one'); const two = path.join(root, 'two');
  auth(one, 'same'); auth(two, 'same');
  const pool = new Pool(path.join(root, 'pool'));
  for (const invalid of ['', '../escape', 'a/b', '.hidden', 'space name', 'x'.repeat(49)])
    assert.throws(() => nameCheck(invalid), Failure);
  pool.add('first', one, false);
  assert.throws(() => pool.add('second', two, false), /Already registered as first/);
  assert.throws(() => pool.add('../escape', one, false), Failure);
  assert.deepEqual(pool.names(), ['first']);
});

test('credentials and pool storage require restrictive owned regular files', { concurrency: false }, () => {
  const root = temp(); const home = path.join(root, 'home');
  auth(home, 'private', 'private-account', 0o644);
  assert.throws(() => credentialIdentity(home), /mode 600/);
  fs.chmodSync(path.join(home, 'auth.json'), 0o600);
  assert.equal(credentialIdentity(home).email, 'private@example.test');
  const linkedHome = path.join(root, 'linked-home'); fs.mkdirSync(linkedHome, { mode: 0o700 });
  fs.symlinkSync(path.join(home, 'auth.json'), path.join(linkedHome, 'auth.json'));
  assert.throws(() => credentialIdentity(linkedHome), /owned regular file/);
  const pool = new Pool(path.join(root, 'pool'));
  assert.equal(fs.statSync(pool.root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(pool.root, 'accounts')).mode & 0o777, 0o700);
});

test('quota headroom considers every bucket and both windows, failing closed on malformed data', { concurrency: false }, () => {
  const limits = { rateLimitsByLimitId: {
    alpha: { primary: { usedPercent: 10, resetsAt: future }, secondary: { usedPercent: 65, resetsAt: future } },
    beta: { primary: { usedPercent: 40, resetsAt: future } },
  } };
  assert.equal(headroom(limits), 35);
  assert.equal(headroom({ rateLimits: { primary: { usedPercent: 1, resetsAt: future }, secondary: { usedPercent: 100, resetsAt: future } } }), 0);
  assert.equal(headroom({ rateLimits: { primary: { usedPercent: 10, resetsAt: future - 7200 } } }), null);
  assert.equal(headroom({ rateLimits: { primary: { usedPercent: '10', resetsAt: future } } }), null);
  assert.equal(headroom({ rateLimits: { rateLimitReachedType: 'primary' } }), 0);
});

test('automatic choice excludes stale, unknown, and insufficient accounts', { concurrency: false }, () => {
  const stale = new Date(Date.now() - 61_000).toISOString();
  const futureChecked = new Date(Date.now() + 61_000).toISOString();
  assert.equal(choose([account('stale', 90, 'ready', stale), account('future', 99, 'ready', futureChecked), account('unknown', 99, 'unknown'), account('low', 9), account('best', 55)], 10).name, 'best');
  assert.equal(choose([account('bad', 90, 'ready')], 91), undefined);
  assert.equal(choose([{ ...account('malformed', 90), limits: {} }], 0), undefined);
});

test('run binds the selected home, preserves native argv, and scrubs inherited credentials', { concurrency: false }, async () => {
  resetEnv(); const root = temp(); const home = path.join(root, 'account-home'); const log = path.join(root, 'native.log');
  auth(home, 'bound');
  process.env.CODEX_SWITCH_HOME = path.join(root, 'pool');
  process.env.CODEX_SWITCH_CODEX = fakeCodex;
  process.env.CODEX_SWITCH_TEST_LOG = log;
  process.env.OPENAI_API_KEY = 'synthetic-key'; process.env.CODEX_ACCESS_TOKEN = 'synthetic-access'; process.env.CODEX_AUTH_TOKEN = 'synthetic-auth';
  assert.equal((await capturedMain(['import', '--source-home', home, 'bound'])).code, 0);
  const result = await capturedMain(['run', '--account', 'bound', '--', 'resume', '--last']);
  assert.equal(result.code, 0, result.err.join('\n'));
  const invocation = JSON.parse(fs.readFileSync(log, 'utf8').trim());
  assert.equal(invocation.codeHome, new Pool().get('bound').home);
  assert.notEqual(invocation.codeHome, fs.realpathSync(home));
  assert.equal(invocation.apiKey, undefined);
  assert.equal(invocation.accessToken, undefined);
  assert.equal(invocation.authLeak, undefined);
  assert.deepEqual(invocation.args, ['-c', 'cli_auth_credentials_store="file"', '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"', 'resume', '--last']);
  resetEnv();
});

test('run refuses forbidden subcommands and backend config anywhere in native argv', { concurrency: false }, async () => {
  resetEnv(); const root = temp(); const home = path.join(root, 'account-home'); const log = path.join(root, 'native.log');
  auth(home, 'guarded');
  process.env.CODEX_SWITCH_HOME = path.join(root, 'pool');
  process.env.CODEX_SWITCH_CODEX = fakeCodex;
  process.env.CODEX_SWITCH_TEST_LOG = log;
  assert.equal((await capturedMain(['import', '--source-home', home, 'guarded'])).code, 0);
  for (const forwarded of [
    ['--no-alt-screen', 'logout'],
    ['-c=chatgpt_base_url=https://invalid.example'],
    ['-c', 'model_providers={ openai={ name="x", base_url="https://invalid.example" } }'],
    ['--config=model_providers.openai.base_url="https://invalid.example"'],
    ['-c', 'profiles.other.model_provider="alternate"'],
    ['--profile', 'other'],
    ['-p', 'other'],
  ]) {
    const result = await capturedMain(['run', '--account', 'guarded', '--', ...forwarded]);
    assert.equal(result.code, 1);
    assert.match(result.err.join('\n'), /Account\/backend overrides and auth commands/);
    assert.equal(fs.existsSync(log), false, `fake Codex launched for ${forwarded.join(' ')}`);
  }
  resetEnv();
});

test('RPC initialization errors and timeouts reject without treating status as ready', { concurrency: false }, async () => {
  resetEnv(); const root = temp(); const home = path.join(root, 'home'); auth(home, 'rpc');
  process.env.CODEX_SWITCH_CODEX = fakeCodex;
  process.env.CODEX_SWITCH_TEST_RPC_MODE = 'initialize-error';
  let rpc = new Rpc(home, 100);
  await assert.rejects(rpc.initialize(), Failure);
  await rpc.close();
  process.env.CODEX_SWITCH_TEST_RPC_MODE = 'timeout';
  rpc = new Rpc(home, 30);
  await assert.rejects(rpc.initialize(), /timed out/);
  await rpc.close(); resetEnv();
});

test('RPC ignores JSON null and arrays before a valid initialization response', { concurrency: false }, async () => {
  resetEnv(); const root = temp(); const home = path.join(root, 'home'); auth(home, 'rpc-noise');
  process.env.CODEX_SWITCH_CODEX = fakeCodex;
  process.env.CODEX_SWITCH_TEST_RPC_MODE = 'null-and-array';
  const rpc = new Rpc(home, 1000);
  try { await rpc.initialize(); }
  finally { await rpc.close(); resetEnv(); }
});

test('staged same-account re-login replaces synthetic auth and preserves its identity', { concurrency: false }, async () => {
  resetEnv(); const root = temp(); const home = path.join(root, 'account-home'); auth(home, 'renew');
  process.env.CODEX_SWITCH_HOME = path.join(root, 'pool');
  process.env.CODEX_SWITCH_CODEX = fakeCodex;
  process.env.CODEX_SWITCH_TEST_LOGIN_SUB = 'renew';
  const pool = new Pool(process.env.CODEX_SWITCH_HOME); const existing = pool.add('renew', home, true);
  const result = await capturedMain(['login', 'renew']);
  assert.equal(result.code, 0, result.err.join('\n'));
  assert.match(result.out.join('\n'), /Login renewed for renew/);
  assert.equal(credentialIdentity(home).identity, existing.identity);
  assert.match(JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')).tokens.refresh_token, /^renewed-refresh-/);
  assert.equal(pool.get('renew').state, 'unchecked');
  assert.equal(fs.readdirSync(pool.dir('renew')).some(name => name.startsWith('.login-')), false);
  resetEnv();
});

test('wrong-account staged re-login preserves the existing synthetic auth', { concurrency: false }, async () => {
  resetEnv(); const root = temp(); const home = path.join(root, 'account-home'); auth(home, 'original');
  const before = fs.readFileSync(path.join(home, 'auth.json'), 'utf8');
  process.env.CODEX_SWITCH_HOME = path.join(root, 'pool');
  process.env.CODEX_SWITCH_CODEX = fakeCodex;
  process.env.CODEX_SWITCH_TEST_LOGIN_SUB = 'different';
  const pool = new Pool(process.env.CODEX_SWITCH_HOME); pool.add('original', home, true);
  const result = await capturedMain(['login', 'original']);
  assert.equal(result.code, 1);
  assert.match(result.err.join('\n'), /signed into a different account/);
  assert.equal(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'), before);
  assert.equal(fs.readdirSync(pool.dir('original')).some(name => name.startsWith('.login-')), false);
  resetEnv();
});

test('first staged login copies neutral config and skips workspace-bound config', { concurrency: false }, async () => {
  resetEnv(); const root = temp(); const source = path.join(root, 'source'); fs.mkdirSync(source, { mode: 0o700 });
  fs.writeFileSync(path.join(source, 'config.toml'), 'forced_chatgpt_workspace_id = "workspace-only"\n');
  fs.writeFileSync(path.join(source, 'safe.config.toml'), 'model = "gpt-test"\n');
  fs.writeFileSync(path.join(source, 'dotted.config.toml'), 'model_providers.openai.base_url = "https://invalid.example"\n');
  fs.writeFileSync(path.join(source, 'inline.config.toml'), 'model_providers = { openai = { base_url = "https://invalid.example" } }\n');
  process.env.CODEX_HOME = source;
  process.env.CODEX_SWITCH_HOME = path.join(root, 'pool');
  process.env.CODEX_SWITCH_CODEX = fakeCodex;
  process.env.CODEX_SWITCH_TEST_LOGIN_SUB = 'new-login';
  const result = await capturedMain(['login', 'new-login']);
  assert.equal(result.code, 0, result.err.join('\n'));
  assert.match(result.out.join('\n'), /Registered new-login/);
  assert.match(result.err.join('\n'), /config\.toml has account\/backend-specific settings/);
  const pool = new Pool(process.env.CODEX_SWITCH_HOME); const saved = pool.get('new-login');
  assert.equal(saved.managed, true);
  assert.equal(fs.existsSync(path.join(saved.home, 'config.toml')), false);
  assert.equal(fs.existsSync(path.join(saved.home, 'dotted.config.toml')), false);
  assert.equal(fs.existsSync(path.join(saved.home, 'inline.config.toml')), false);
  assert.equal(fs.readFileSync(path.join(saved.home, 'safe.config.toml'), 'utf8'), 'model = "gpt-test"\n');
  assert.equal(credentialIdentity(saved.home).email, 'new-login@example.test');
  assert.equal(fs.readdirSync(pool.dir('new-login')).some(name => name.startsWith('.login-')), false);
  resetEnv();
});

test('duplicate-identity first login removes its stage without creating a persistent home', { concurrency: false }, async () => {
  resetEnv(); const root = temp(); const source = path.join(root, 'source'); const existingHome = path.join(root, 'existing-home');
  fs.mkdirSync(source, { mode: 0o700 }); auth(existingHome, 'duplicate');
  process.env.CODEX_HOME = source;
  process.env.CODEX_SWITCH_HOME = path.join(root, 'pool');
  process.env.CODEX_SWITCH_CODEX = fakeCodex;
  process.env.CODEX_SWITCH_TEST_LOGIN_SUB = 'duplicate';
  const pool = new Pool(process.env.CODEX_SWITCH_HOME); pool.add('existing', existingHome, true);
  const result = await capturedMain(['login', 'rejected']);
  assert.equal(result.code, 1);
  assert.match(result.err.join('\n'), /Already registered as existing/);
  const rejected = pool.dir('rejected');
  assert.equal(pool.names().includes('rejected'), false);
  assert.equal(fs.existsSync(path.join(rejected, 'codex-home')), false);
  assert.equal(fs.existsSync(path.join(rejected, 'auth.json')), false);
  assert.equal(fs.readdirSync(rejected).some(name => name.startsWith('.login-')), false);
  resetEnv();
});

test('account locks reject concurrent and stale local owners without deleting a lock', { concurrency: false }, () => {
  const root = temp(); const pool = new Pool(path.join(root, 'pool')); const home = path.join(root, 'home'); auth(home, 'locked'); pool.add('locked', home, false);
  const release = pool.accountLock('locked');
  assert.throws(() => pool.accountLock('locked'), e => e instanceof Failure && e.state === 'busy');
  release();
  const lockDir = path.join(pool.root, '.settings-lock'); fs.mkdirSync(lockDir, { mode: 0o700 });
  fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ host: os.hostname(), pid: 2147483647 }), { mode: 0o600 });
  assert.throws(() => lock(lockDir), e => e instanceof Failure && e.state === 'busy');
  assert.equal(fs.existsSync(path.join(lockDir, 'owner.json')), true);
});
