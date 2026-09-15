import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Failure, credentialSnapshot, atomicJSON, privateDir, lock, probe, choose, headroom } from './core.mjs';

// This controller changes file-based login only. It never attaches to a session.
export class NativeAuto {
  constructor(pool, home, { minRemaining = 5, probeAccount = probe, record = () => {} } = {}) {
    this.pool = pool; this.home = fs.realpathSync(home); this.min = minRemaining;
    this.probeAccount = probeAccount; this.record = record; this.closed = false; this.pending = null;
  }
  tick() {
    if (this.closed) return Promise.resolve();
    if (!this.pending) this.pending = this.check().finally(() => { this.pending = null; });
    return this.pending;
  }
  backup(snapshot) {
    const dir = path.join(this.pool.root, 'auto', 'backups'); privateDir(dir);
    const hash = crypto.createHash('sha256').update(snapshot.text).digest('hex');
    const file = path.join(dir, `${hash}.json`);
    if (!fs.existsSync(file)) atomicJSON(file, snapshot.auth);
  }
  async check() {
    let release;
    try {
      const initial = credentialSnapshot(this.home);
      const current = this.pool.names().map(name => this.pool.get(name)).find(a => a.identity === initial.identity);
      if (!current || !current.managed || fs.realpathSync(current.home) === this.home) {
        this.record({ state: 'unregistered', active: null, remainingPercent: null,
          error: 'Native login needs an independent managed account in the pool.' }); return;
      }
      release = this.pool.accountLock(current.name);
      // Probe the actual native credentials, not the possibly older pool copy.
      // Save only quota metadata back to the managed record, keeping its home.
      const nativePool = {
        get: () => ({ ...current, home: this.home }),
        save: account => this.pool.save({ ...account, home: current.home, managed: true }),
      };
      const checked = await this.probeAccount(nativePool, current.name, { locked: true });
      if (this.closed) return;
      const outgoing = credentialSnapshot(this.home);
      if (outgoing.identity !== initial.identity) { this.record({ state: 'changed', active: null }); return; }
      const remaining = ['ready', 'limited'].includes(checked.state) ? headroom(checked.limits) : null;
      this.record({ state: remaining === null ? 'unknown' : 'watching', active: current.name, remainingPercent: remaining });
      if (remaining === null || (remaining >= this.min && remaining > 0)) return;
      const candidates = [];
      for (const name of this.pool.names()) {
        if (this.closed) return;
        const entry = this.pool.get(name);
        if (name === current.name || !entry.managed || fs.realpathSync(entry.home) === this.home) continue;
        try { candidates.push(await this.probeAccount(this.pool, name)); } catch { /* unavailable */ }
      }
      while (!this.closed) {
        const candidate = choose(candidates, this.min);
        if (!candidate) break;
        candidates.splice(candidates.indexOf(candidate), 1);
        let candidateRelease, settingsRelease;
        try {
          candidateRelease = this.pool.accountLock(candidate.name);
          const verified = await this.probeAccount(this.pool, candidate.name, { locked: true });
          if (this.closed) return;
          if (!choose([verified], this.min)) continue;
          const incoming = credentialSnapshot(verified.home);
          if (incoming.identity !== verified.identity) continue;
          if (credentialSnapshot(this.home).text !== outgoing.text) {
            this.record({ state: 'changed', active: null, error: 'Native login changed during polling; retrying next poll.' }); return;
          }
          const saved = credentialSnapshot(current.home);
          if (saved.identity !== current.identity) throw new Failure('Managed account identity changed.');
          settingsRelease = lock(path.join(this.pool.root, '.settings-lock'));
          // Keep recoverable copies before updating either credential location.
          this.backup(saved); this.backup(outgoing);
          // Native login/logout ignores our lock; recheck after backup work too.
          if (credentialSnapshot(this.home).text !== outgoing.text) {
            this.record({ state: 'changed', active: null }); return;
          }
          atomicJSON(path.join(current.home, 'auth.json'), outgoing.auth);
          atomicJSON(path.join(this.home, 'auth.json'), incoming.auth);
          atomicJSON(path.join(this.pool.root, 'settings.json'), { selected: candidate.name });
          this.record({ state: 'switched', active: candidate.name, previous: current.name,
            remainingPercent: headroom(verified.limits), switchedAt: new Date().toISOString() });
          return;
        } catch (e) {
          if (e instanceof Failure && e.state === 'busy') continue;
          throw e;
        } finally { settingsRelease?.(); candidateRelease?.(); }
      }
      if (!this.closed) this.record({ state: 'no-alternative', active: current.name, remainingPercent: remaining });
    } catch (e) {
      if (!this.closed) this.record({ state: e instanceof Failure && e.state === 'busy' ? 'busy' : 'unknown',
        error: 'Unable to verify or update native login; inspect credentials and retry.', remainingPercent: null });
    } finally { release?.(); }
  }
}

export async function runAuto(pool, home, { minRemaining = 5, interval = 30, once = false } = {}) {
  // Do not create/change native home permissions: it belongs to ordinary Codex.
  const s = fs.lstatSync(home);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o022))
    throw new Failure('Native Codex home must be an owned directory, not writable by others.');
  home = fs.realpathSync(home);
  const dir = path.join(pool.root, 'auto'); privateDir(dir);
  const release = lock(path.join(dir, '.lock'));
  let homeRelease, timer, wake, controller;
  let stopped = false;
  let snapshot = { pid: process.pid, host: os.hostname(), home, minRemaining, interval,
    startedAt: new Date().toISOString(), state: 'starting', active: null, remainingPercent: null };
  const record = value => {
    snapshot = { ...snapshot, error: undefined, ...value, checkedAt: new Date().toISOString() };
    atomicJSON(path.join(dir, 'status.json'), snapshot);
  };
  const stop = () => { stopped = true; if (controller) controller.closed = true; clearTimeout(timer); wake?.(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    homeRelease = lock(path.join(home, '.codex-switch-auto.lock'));
    controller = new NativeAuto(pool, home, { minRemaining, record });
    record({ state: 'starting' });
    do {
      await controller.tick();
      if (once || stopped) break;
      await new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, interval * 1000); });
      wake = null;
    } while (!stopped);
  } finally {
    stop();
    try { record({ state: 'stopped', lastState: snapshot.state }); }
    finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); homeRelease?.(); release(); }
  }
}
