import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

export class Failure extends Error {
  constructor(message, state = 'unknown') { super(message); this.state = state; }
}
export function nameCheck(name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(name ?? ''))
    throw new Failure('Account name must be 1–48 letters, digits, underscores or hyphens.');
  return name;
}
export function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const s = fs.lstatSync(dir);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid())
    throw new Failure('Storage must be a directory owned by the current user.');
  fs.chmodSync(dir, 0o700);
}
export function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw new Failure('Cannot read storage JSON; check file permissions and integrity.');
  }
}
export function atomicJSON(file, value) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
export function lock(dir) {
  try { fs.mkdirSync(dir, { mode: 0o700 }); }
  catch (e) {
    if (e.code !== 'EEXIST') throw new Failure('Cannot acquire storage lock.');
    // Fail closed on remote-host locks and interrupted lock creation.
    // Do not reclaim stale directory locks automatically: two contenders could
    // otherwise mistake a newly acquired lock for the dead owner's lock.
    throw new Failure('Account is busy (or has a lock requiring manual inspection).', 'busy');
  }
  const ownerFile = path.join(dir, 'owner.json');
  atomicJSON(ownerFile, { pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() });
  return () => { fs.unlinkSync(ownerFile); fs.rmdirSync(dir); };
}

export class Pool {
  constructor(root = process.env.CODEX_SWITCH_HOME || path.join(os.homedir(), '.codex', 'account-pool')) {
    this.root = path.resolve(root);
    privateDir(this.root);
    privateDir(path.join(this.root, 'accounts'));
  }
  dir(name) { return path.join(this.root, 'accounts', nameCheck(name)); }
  names() {
    return fs.readdirSync(path.join(this.root, 'accounts'), { withFileTypes: true })
      .filter(d => d.isDirectory() && fs.existsSync(path.join(this.dir(d.name), 'account.json')))
      .map(d => d.name).sort();
  }
  get(name) {
    const value = readJSON(path.join(this.dir(name), 'account.json'));
    if (value.name !== name || !path.isAbsolute(value.home || '')) throw new Failure('Invalid account record.');
    return value;
  }
  save(account) { atomicJSON(path.join(this.dir(account.name), 'account.json'), account); }
  selected() { return readJSON(path.join(this.root, 'settings.json'), {}).selected; }
  select(name) {
    this.get(name);
    const release = lock(path.join(this.root, '.settings-lock'));
    try { atomicJSON(path.join(this.root, 'settings.json'), { selected: name }); }
    finally { release(); }
  }
  accountLock(name) { return lock(path.join(this.dir(name), '.lock')); }
  add(name, home, managed, { destination } = {}) {
    nameCheck(name);
    const identity = credentialIdentity(home);
    const release = lock(path.join(this.root, '.settings-lock'));
    try {
      if (this.names().includes(name)) throw new Failure('That account name is already registered.');
      for (const existing of this.names()) {
        const a = this.get(existing);
        if (a.identity === identity.identity || fs.realpathSync(a.home) === fs.realpathSync(home))
          throw new Failure(`Already registered as ${existing}.`);
      }
      privateDir(this.dir(name));
      if (destination) {
        if (fs.existsSync(destination)) throw new Failure('An unregistered account home already exists; inspect it before retrying.');
        fs.renameSync(home, destination);
      }
      const finalHome = destination || home;
      const account = { name, home: fs.realpathSync(finalHome), managed, ...identity,
        state: 'unchecked', addedAt: new Date().toISOString() };
      try { this.save(account); }
      catch (e) { if (destination) fs.renameSync(destination, home); throw e; }
      if (!this.selected()) atomicJSON(path.join(this.root, 'settings.json'), { selected: name });
      return account;
    } finally { release(); }
  }
}

export function credentialIdentity(home) {
  const file = path.join(home, 'auth.json');
  let s;
  try { s = fs.lstatSync(file); } catch { throw new Failure('No file-based login found. Use codex-switch login NAME.', 'needs-login'); }
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o077))
    throw new Failure('auth.json must be an owned regular file with mode 600.');
  const auth = readJSON(file);
  if (auth.auth_mode !== 'chatgpt' || !auth.tokens?.refresh_token || !auth.tokens?.access_token)
    throw new Failure('Only file-based ChatGPT subscription logins are supported.', 'needs-login');
  let claims;
  try { claims = JSON.parse(Buffer.from(auth.tokens.id_token.split('.')[1], 'base64url').toString()); }
  catch { throw new Failure('Login identity is unreadable; sign in again.', 'needs-login'); }
  if (!claims.sub || !auth.tokens.account_id) throw new Failure('Login is missing account identity.', 'needs-login');
  // These are labels from local credentials, not proof of a valid server session.
  return {
    identity: crypto.createHash('sha256').update(`${claims.sub}\0${auth.tokens.account_id}`).digest('hex'),
    email: typeof claims.email === 'string' ? claims.email : '(no email)',
  };
}

export function codexEnv(home) {
  const env = { ...process.env, CODEX_HOME: home };
  // Do not inherit alternative credentials or an existing Codex session identity.
  for (const key of Object.keys(env)) {
    if (/^(OPENAI_API_KEY|CODEX_API_KEY|CODEX_ACCESS_TOKEN|CODEX_AUTH_|CODEX_THREAD_ID|CODEX_INTERNAL_|CODEX_REMOTE_TOKEN)/.test(key)) delete env[key];
  }
  return env;
}
export const authArgs = ['-c', 'cli_auth_credentials_store="file"', '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"'];
export function codexBinary() { return process.env.CODEX_SWITCH_CODEX || 'codex'; }

export class Rpc {
  constructor(home, timeout = 25000) {
    this.timeout = timeout;
    this.next = 1;
    this.pending = new Map();
    this.child = spawn(codexBinary(), ['app-server', '--listen', 'stdio://', ...authArgs], {
      cwd: home, env: codexEnv(home), stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Never forward server stderr: it can contain credentials or personal paths.
    this.child.stderr.resume();
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
      if (msg.method && msg.id !== undefined) {
        this.send({ id: msg.id, error: { code: -32601, message: 'Unsupported client request' } });
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer); this.pending.delete(msg.id);
      if (msg.error) {
        const message = String(msg.error.message ?? '');
        const invalid = /refresh_token_(expired|reused|invalidated)|invalid_grant|sign in again|log in again|not authenticated|authentication required/i.test(message);
        p.reject(new Failure(invalid ? 'Sign in again to restore this account.' : 'Codex account request failed; status is unknown.', invalid ? 'needs-login' : 'unknown'));
      } else p.resolve(msg.result);
    });
    this.child.on('error', () => this.fail('Cannot start Codex. Check installation and PATH.'));
    this.child.on('exit', () => this.fail('Codex account service exited.'));
    this.child.stdin.on('error', () => this.fail('Codex account service disconnected.'));
    this.child.stdout.on('error', () => this.fail('Codex account service output failed.'));
    this.child.stderr.on('error', () => this.fail('Codex account service diagnostics failed.'));
  }
  fail(message) {
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Failure(message)); }
    this.pending.clear();
  }
  send(msg) { if (!this.closed) this.child.stdin.write(JSON.stringify(msg) + '\n'); }
  request(method, params = {}) {
    if (this.closed) return Promise.reject(new Failure('Codex account service is unavailable.'));
    return new Promise((resolve, reject) => {
      const id = this.next++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Failure('Account query timed out; status is unknown.')); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'codex_switch', version: '0.1.0' } });
    this.send({ method: 'initialized', params: {} });
  }
  async close() {
    this.fail('Account service closed.'); this.lines.close();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.end(); this.child.kill('SIGTERM');
    await new Promise(resolve => {
      const timer = setTimeout(() => { this.child.kill('SIGKILL'); resolve(); }, 1500);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}

export function buckets(result) {
  const values = Object.values(result?.rateLimitsByLimitId ?? {});
  return values.length ? values : result?.rateLimits ? [result.rateLimits] : [];
}
export function headroom(result, now = Date.now() / 1000) {
  const all = buckets(result);
  if (!all.length) return null;
  const remaining = [];
  for (const bucket of all) {
    if (!bucket || typeof bucket !== 'object') return null;
    if (bucket.rateLimitReachedType) return 0;
    let found = false;
    for (const window of [bucket.primary, bucket.secondary]) {
      if (!window) continue;
      found = true;
      if (!Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100 ||
          !Number.isFinite(window.resetsAt) || window.resetsAt <= now) return null;
      remaining.push(100 - window.usedPercent);
    }
    if (!found) return null;
  }
  return remaining.length ? Math.min(...remaining) : null;
}
export function choose(accounts, minRemaining = 10) {
  return accounts.filter(a => a.state === 'ready' && Date.now() - Date.parse(a.checkedAt) >= 0 && Date.now() - Date.parse(a.checkedAt) < 60000)
    .map(a => ({ a, remaining: headroom(a.limits) }))
    .filter(x => x.remaining !== null && x.remaining > 0 && x.remaining >= minRemaining)
    .sort((x, y) => y.remaining - x.remaining || x.a.name.localeCompare(y.a.name))[0]?.a;
}
export async function probe(pool, name, { locked = false } = {}) {
  let release;
  const initial = pool.get(name);
  try { release = locked ? () => {} : pool.accountLock(name); }
  catch (e) { if (e.state === 'busy') return { ...initial, state: 'busy', error: e.message }; throw e; }
  let rpc;
  let interrupted;
  const stop = () => { interrupted = 'interrupted'; rpc?.fail('Account query interrupted.'); rpc?.child.kill('SIGTERM'); };
  const terminate = () => { stop(); interrupted = 'terminated'; };
  process.on('SIGINT', stop); process.on('SIGTERM', terminate);
  try {
    const local = credentialIdentity(initial.home);
    if (local.identity !== initial.identity) throw new Failure('Login identity changed outside codex-switch; use the original account or register a new name.', 'identity-changed');
    rpc = new Rpc(initial.home);
    await rpc.initialize();
    const result = await rpc.request('account/read', { refreshToken: false });
    if (result?.account?.type !== 'chatgpt') throw new Failure('Account needs a ChatGPT login.', 'needs-login');
    const limits = await rpc.request('account/rateLimits/read');
    if (credentialIdentity(initial.home).identity !== initial.identity)
      throw new Failure('Account changed while checking usage.', 'identity-changed');
    const current = { ...initial, state: headroom(limits) === null ? 'unknown' : headroom(limits) === 0 ? 'limited' : 'ready',
      plan: result.account.planType, limits, checkedAt: new Date().toISOString(), error: undefined };
    pool.save(current); return current;
  } catch (e) {
    if (interrupted) throw new Failure('Account query interrupted.', interrupted);
    const current = { ...initial, state: e instanceof Failure ? e.state : 'unknown',
      error: e instanceof Failure ? e.message : 'Account check failed.', checkedAt: new Date().toISOString() };
    pool.save(current); return current;
  } finally {
    if (rpc) await rpc.close();
    process.off('SIGINT', stop); process.off('SIGTERM', terminate);
    release();
    if (interrupted) throw new Failure('Account query interrupted.', interrupted);
  }
}

export async function native(home, args, { cwd } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(codexBinary(), args, { cwd, env: codexEnv(home), stdio: 'inherit' });
    // Terminal SIGINT reaches both processes; forwarding it would send it twice.
    const interrupt = () => {};
    const terminate = () => child.kill('SIGTERM');
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    const cleanup = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
    child.once('error', () => { cleanup(); reject(new Failure('Cannot start Codex. Check installation and PATH.')); });
    child.once('exit', (code, signal) => { cleanup(); resolve(code ?? (signal === 'SIGINT' ? 130 : 143)); });
  });
}

export function prepareHome(pool, name, source, target) {
  const base = pool.dir(name);
  privateDir(base);
  const home = target || path.join(base, 'codex-home');
  privateDir(home);
  // Copy settings once; account-specific changes do not mutate the original.
  for (const file of fs.readdirSync(source).filter(x => x === 'config.toml' || x.endsWith('.config.toml'))) {
    const config = fs.readFileSync(path.join(source, file), 'utf8');
    // Conservatively skip an entire account/backend-bound config instead of
    // attempting lossy TOML surgery. Do not alter managed admin requirements.
    if (/^\s*(?:["']?(?:forced_chatgpt_workspace_id|chatgpt_base_url|model_providers?(?:\.[^=]+)?)["']?\s*=|\[\s*["']?model_providers["']?[.\]])/m.test(config)) {
      console.error(`codex-switch: ${file} has account/backend-specific settings; using default settings for this file in the new login home.`);
      continue;
    }
    if (!fs.existsSync(path.join(home, file)))
      fs.copyFileSync(path.join(source, file), path.join(home, file), fs.constants.COPYFILE_EXCL);
    fs.chmodSync(path.join(home, file), 0o600);
  }
  // Deliberate shared user instructions/skills; history and credentials stay separate.
  for (const file of ['AGENTS.md', 'skills', 'rules', 'agents', 'prompts']) {
    if (fs.existsSync(path.join(source, file)) && !fs.existsSync(path.join(home, file)))
      fs.symlinkSync(path.join(source, file), path.join(home, file));
  }
  return home;
}
