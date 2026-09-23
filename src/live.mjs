import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import {
  Failure, Rpc, atomicJSON, privateDir, credentialIdentity, readJSON,
  codexBinary, codexEnv, authArgs, prepareHome, lock, probe, choose, headroom,
} from './core.mjs';

export class SocketRpc extends EventEmitter {
  constructor(socket, timeout = 20000) {
    super(); this.timeout = timeout; this.pending = new Map(); this.id = 0;
    this.controllerRequests = new Set();
    this.ws = new WebSocket(`ws+unix:${socket}:/`, { perMessageDeflate: false, handshakeTimeout: 5000, maxPayload: 32 * 1024 * 1024 });
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', () => reject(new Failure('Cannot connect to the private Codex service.')));
    });
    this.ws.on('error', () => this.fail());
    this.ws.on('close', () => this.fail());
    this.ws.on('message', data => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
      if (msg.method && msg.id !== undefined) {
        const handle = msg.method === 'account/chatgptAuthTokens/refresh' && this.refresh;
        const work = Promise.resolve().then(() => {
          if (!handle) throw new Failure('Unsupported controller request.');
          return handle(msg.params);
        }).then(result => this.send({ id: msg.id, result }), () => this.send({ id: msg.id, error: { code: -32000, message: 'Account refresh unavailable.' } }))
          .catch(() => {});
        this.controllerRequests.add(work);
        void work.then(() => this.controllerRequests.delete(work));
      } else if (msg.method) this.emit('notification', msg);
      else {
        const p = this.pending.get(msg.id); if (!p) return;
        this.pending.delete(msg.id); clearTimeout(p.timer);
        if (msg.error) p.reject(new Failure('Codex service request failed; automatic switching is paused.'));
        else p.resolve(msg.result);
      }
    });
  }
  send(msg) { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg)); }
  request(method, params = {}) {
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Failure('Private Codex service is disconnected.'));
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Failure('Codex service request timed out.')); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer }); this.send({ id, method, params });
    });
  }
  async initialize() {
    await this.opened;
    await this.request('initialize', { clientInfo: { name: 'codex_switch_live', version: '0.4.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized', params: {} });
  }
  async drainControllerRequests() { await Promise.all([...this.controllerRequests]); }
  fail() {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Failure('Private Codex service disconnected.')); }
    this.pending.clear();
  }
  close() { this.fail(); this.ws.terminate(); }
}

export function tokenBundle(account) {
  if (credentialIdentity(account.home).identity !== account.identity) throw new Failure('Account credential identity changed.');
  const tokens = readJSON(path.join(account.home, 'auth.json')).tokens;
  return { accessToken: tokens.access_token, chatgptAccountId: tokens.account_id, chatgptPlanType: account.plan || undefined };
}

async function refreshedBundle(account) {
  const rpc = new Rpc(account.home, 3000);
  try {
    await rpc.initialize();
    await rpc.request('account/read', { refreshToken: true });
    return tokenBundle(account);
  } finally { await rpc.close(); }
}

// No runtime auth.json copies: only the managed account home owns refresh tokens.
// The live service receives an access token in memory through the official API.
export class LiveSwitch {
  constructor(pool, rpc, { minRemaining = 10, probeAccount = probe, refreshAccount = refreshedBundle, record = () => {} } = {}) {
    this.pool = pool; this.rpc = rpc; this.min = minRemaining;
    this.probeAccount = probeAccount; this.refreshAccount = refreshAccount; this.record = record;
    this.active = null; this.leases = new Map(); this.closed = false; this.halted = false;
    this.serial = Promise.resolve(); this.tickPromise = null;
    this.refreshSerial = Promise.resolve(); this.refreshBlocked = false;
    this.pendingAccount = null; this.authGeneration = 0;
    rpc.refresh = params => this.refresh(params);
  }
  refresh(params) {
    const account = this.pendingAccount || this.active;
    const generation = this.authGeneration;
    if (!account || this.closed || this.halted || this.refreshBlocked)
      return Promise.reject(new Failure('No active managed account.'));
    const validate = () => {
      if (this.closed || this.halted || generation !== this.authGeneration || !this.leases.has(account.name))
        throw new Failure('Account refresh no longer belongs to the current login.');
      return tokenBundle(account);
    };
    // Reverse RPCs must not queue behind a login waiting for their response.
    // Serialize refreshes separately and drain them before changing accounts.
    const next = this.refreshSerial.then(async () => {
      const current = validate();
      if (params?.previousAccountId && params.previousAccountId !== current.chatgptAccountId) return current;
      const result = await this.refreshAccount(account);
      const registered = validate();
      if (result?.chatgptAccountId !== registered.chatgptAccountId || typeof result.accessToken !== 'string' || !result.accessToken)
        throw new Failure('Account refresh returned an unexpected identity.');
      return result;
    });
    this.refreshSerial = next.catch(() => {});
    return next;
  }
  exclusive(operation) {
    const next = this.serial.then(operation);
    this.serial = next.catch(() => {}); return next;
  }
  async activate(account) {
    return this.exclusive(async () => {
      if (this.closed || this.halted) return false;
      const name = account.name;
      let submitted = false;
      try {
        // account/read exposes email, not the immutable workspace identity.
        // Do not claim a confirmed switch between indistinguishable entries.
        if (this.pool.names().some(other => {
          const entry = this.pool.get(other);
          return entry.email === account.email && entry.identity !== account.identity;
        })) return false;
        if (!this.leases.has(name)) this.leases.set(name, this.pool.accountLock(name));
        const checked = await this.probeAccount(this.pool, name, { locked: true });
        if (!choose([checked], this.min)) {
          this.leases.get(name)(); this.leases.delete(name); return false;
        }
        // Stop admitting old-account refreshes before draining existing work.
        this.refreshBlocked = true;
        await this.refreshSerial;
        await this.rpc.drainControllerRequests?.();
        if (this.closed || this.halted) throw new Failure('Account switch was cancelled.');
        const bundle = tokenBundle(checked);
        const previous = this.active;
        this.pendingAccount = checked;
        this.authGeneration++;
        this.refreshBlocked = false;
        submitted = true;
        await this.rpc.request('account/login/start', { type: 'chatgptAuthTokens', ...bundle });
        const visible = (await this.rpc.request('account/read', { refreshToken: false })).account;
        if (this.closed || this.halted) throw new Failure('Account switch was cancelled.');
        if (visible?.type !== 'chatgpt' || visible.email !== checked.email) throw new Failure('Live account identity confirmation failed.');
        this.active = checked;
        if (previous && previous.name !== name) { this.leases.get(previous.name)?.(); this.leases.delete(previous.name); }
        this.record({ state: 'watching', active: name, previous: previous?.name, remainingPercent: headroom(checked.limits), switchedAt: new Date().toISOString() });
        return true;
      } catch (error) {
        if (submitted) {
          // A timed-out login may have applied. Keep both leases until shutdown;
          // never guess which credential owner the server is using.
          this.halted = true; this.record({ state: 'paused', active: this.active?.name, error: 'Account switch could not be confirmed.' });
          throw error;
        }
        this.leases.get(name)?.(); this.leases.delete(name); return false;
      } finally {
        this.pendingAccount = null;
        this.refreshBlocked = false;
      }
    });
  }
  async pickAlternative() {
    const candidates = [];
    for (const name of this.pool.names()) {
      if (name === this.active?.name || this.closed) continue;
      try { candidates.push(await this.probeAccount(this.pool, name)); } catch { /* unverified accounts are ineligible */ }
    }
    while (!this.closed) {
      const selected = choose(candidates, this.min); if (!selected) return false;
      if (await this.activate(selected)) return true;
      candidates.splice(candidates.indexOf(selected), 1);
    }
    return false;
  }
  async tick() {
    if (this.closed || this.halted) return;
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = this.check().finally(() => { this.tickPromise = null; });
    return this.tickPromise;
  }
  async check() {
    try {
      if (!this.active) return await this.pickAlternative();
      const visible = (await this.rpc.request('account/read', { refreshToken: false })).account;
      if (visible?.type !== 'chatgpt' || visible.email !== this.active.email) {
        this.halted = true; this.record({ state: 'paused', active: this.active.name, error: 'Live account changed outside the controller.' }); return;
      }
      const limits = await this.rpc.request('account/rateLimits/read');
      if (this.closed) return;
      const remaining = headroom(limits);
      this.active = { ...this.active, limits, checkedAt: new Date().toISOString(),
        state: remaining === null ? 'unknown' : remaining === 0 ? 'limited' : 'ready', error: undefined };
      this.pool.save(this.active);
      this.record({ state: remaining === null ? 'unknown' : 'watching', active: this.active.name, remainingPercent: remaining });
      if (remaining !== null && (remaining < this.min || remaining === 0)) {
        if (!await this.pickAlternative() && !this.closed)
          this.record({ state: 'no-alternative', active: this.active.name, remainingPercent: remaining });
      }
    } catch {
      if (!this.closed && !this.halted) this.record({ state: 'unknown', active: this.active?.name, error: 'Quota query failed; no account change was made.' });
    }
  }
  async close() {
    this.closed = true;
    await this.tickPromise?.catch(() => {}); await this.serial;
    await this.refreshSerial;
    await this.rpc.drainControllerRequests?.();
    for (const release of this.leases.values()) release(); this.leases.clear();
  }
}

async function stopProcess(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

export async function runLive(pool, forwarded, { minRemaining = 10, interval = 30 } = {}) {
  if (forwarded.some(x => ['exec', 'e', 'review', 'cloud', 'mcp', 'plugin', 'agents'].includes(x)))
    throw new Failure('--auto live switching supports the interactive Codex UI only.');
  const dir = path.join(pool.root, 'live'); privateDir(dir);
  const release = lock(path.join(dir, '.lock'));
  const home = path.join(dir, 'codex-home');
  const socket = path.join(dir, 'control.sock');
  let server, ui, rpc, controller, timer;
  let stopping = false;
  let snapshot = { state: 'starting', pid: process.pid, host: (await import('node:os')).hostname(), startedAt: new Date().toISOString(), minRemaining, interval };
  const record = value => { snapshot = { ...snapshot, error: undefined, ...value, checkedAt: new Date().toISOString() }; atomicJSON(path.join(dir, 'status.json'), snapshot); };
  const interrupt = () => { if (!ui) { stopping = true; rpc?.close(); } };
  const terminate = () => { stopping = true; ui?.kill('SIGTERM'); rpc?.close(); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try {
    if (Buffer.byteLength(socket) >= 104 || /[:?]/.test(socket)) throw new Failure('Account pool path is too long or contains unsupported socket characters.');
    if (fs.existsSync(socket)) throw new Failure('A live socket already exists; inspect its owner before restarting.');
    const names = pool.names();
    if (!names.length) throw new Failure('No accounts. Run codex-switch login NAME.');
    const source = pool.get(pool.selected() || names[0]);
    prepareHome(pool, source.name, source.home, home);
    if (fs.existsSync(path.join(home, 'auth.json'))) throw new Failure('Live home unexpectedly contains stored credentials.');
    record({ state: 'starting' });
    server = spawn(codexBinary(), ['app-server', '--listen', `unix://${socket}`, ...authArgs, '-c', 'cli_auth_credentials_store="ephemeral"'], {
      cwd: home, env: { ...codexEnv(home), CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    server.stdout.resume(); server.stderr.resume();
    let serverError = false;
    server.on('error', () => { serverError = true; });
    for (let i = 0; i < 200 && !fs.existsSync(socket); i++) {
      if (serverError || server.exitCode !== null || stopping) throw new Failure('Cannot start the live Codex service.');
      await new Promise(r => setTimeout(r, 50));
    }
    if (!fs.existsSync(socket)) throw new Failure('Private Codex socket did not become ready.');
    const mode = fs.statSync(socket).mode & 0o077;
    if (mode) throw new Failure('Private Codex socket has unsafe permissions.');
    rpc = new SocketRpc(socket); await rpc.initialize();
    controller = new LiveSwitch(pool, rpc, { minRemaining, record });
    if (!await controller.pickAlternative() || stopping) throw new Failure('No verified account meets the remaining-quota threshold.');
    console.error(`codex-switch: ${controller.active.name} (live auto-switch, below ${minRemaining}%)`);
    ui = spawn(codexBinary(), ['--remote', `unix://${socket}`, ...forwarded], { env: codexEnv(home), stdio: 'inherit' });
    const completed = new Promise((resolve, reject) => {
      ui.once('error', () => reject(new Failure('Cannot start the Codex terminal UI.')));
      ui.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 143)));
    });
    const poll = async () => {
      if (stopping) return;
      await controller.tick();
      if (!stopping) timer = setTimeout(poll, interval * 1000);
    };
    timer = setTimeout(poll, interval * 1000);
    return await completed;
  } finally {
    stopping = true; clearTimeout(timer);
    if (controller) controller.closed = true;
    // Access-token owner goes away before canonical credential leases are freed.
    rpc?.close();
    await stopProcess(ui); await stopProcess(server);
    await controller?.close();
    try { record({ state: 'stopped' }); }
    finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); release(); }
  }
}
