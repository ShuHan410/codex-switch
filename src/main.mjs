import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Pool, Failure, nameCheck, credentialIdentity, privateDir, prepareHome, native, authArgs, probe, buckets, headroom, readJSON } from './core.mjs';

const help = `codex-switch 0.2.0 — ChatGPT subscription accounts for Codex CLI

  login NAME [--device-auth]          Official login, then register account
  import NAME [--source-home PATH]    Register an existing file login in place
  list [--json]                      Accounts and cached status
  usage [NAME | --all] [--json]       Check quota windows (default: all)
  use NAME                           Select account for subsequent runs
  run [--account NAME | --auto] [--min-remaining PERCENT] [--poll-interval SECONDS] [-- CODEX_ARGS...]
  status                             Show live automatic-switch status
  doctor                             Check local setup without exposing tokens

Examples:
  codex-switch login second --device-auth
  codex-switch usage --all
  codex-switch use second
  codex-switch run -- --no-alt-screen
  codex-switch run --auto --min-remaining 15
  codex-switch run -- resume --last

use affects codex-switch run; plain codex keeps its original login.
--auto keeps the same terminal/conversation and switches live below the threshold.
It checks every 30 seconds by default; use status to inspect without notifications.
Auto conversations share a dedicated live home; manual runs keep per-account history.
CODEX_SWITCH_HOME overrides pool storage. CODEX_SWITCH_CODEX overrides the binary.
`;
function clean(value) { return String(value ?? '-').replace(/[\x00-\x1f\x7f-\x9f]/g, '?'); }
function durationLabel(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'unknown duration';
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}
function publicAccount(a, selected) {
  return { name: a.name, selected: a.name === selected, email: a.email, state: a.state,
    plan: a.plan, checkedAt: a.checkedAt, error: a.error,
    remainingPercent: a.state === 'ready' || a.state === 'limited' ? headroom(a.limits) : null,
    limits: a.limits };
}
function show(accounts, selected, json, detail = false) {
  if (json) { console.log(JSON.stringify(accounts.map(a => publicAccount(a, selected)), null, 2)); return; }
  if (!accounts.length) { console.log('No accounts. Run: codex-switch login NAME'); return; }
  for (const a of accounts) {
    console.log(`${a.name === selected ? '*' : ' '} ${a.name}  ${clean(a.email)}  ${clean(a.plan)}  ${a.state}  checked=${clean(a.checkedAt)}`);
    if (a.error) console.log(`    ${clean(a.error)}`);
    if (detail) for (const b of buckets(a.limits)) {
      for (const kind of ['primary', 'secondary']) {
        const w = b[kind]; if (!w) continue;
        const date = Number.isFinite(w.resetsAt) ? new Date(w.resetsAt * 1000) : null;
        const reset = date && Number.isFinite(date.getTime()) ? date.toLocaleString() : '?';
        console.log(`    ${clean(b.limitId)} ${durationLabel(w.windowDurationMins)}: ${clean(w.usedPercent)}% used; resets=${reset}${a.state === 'busy' || a.state === 'unknown' || a.state === 'needs-login' ? ' (cached; not currently verified)' : ''}`);
      }
    }
  }
}
function take(args, flag) {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Failure(`${flag} requires a value.`);
  const value = args[i + 1]; args.splice(i, 2); return value;
}
function flag(args, name) { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; }
function none(args) { if (args.length) throw new Failure('Unexpected arguments. See codex-switch --help.'); }

export async function main(argv = process.argv.slice(2)) {
  process.umask(0o077);
  try {
    const args = [...argv]; const command = args.shift();
    if (!command || ['help', '--help', '-h'].includes(command)) { console.log(help); return; }
    if (command === '--version') { console.log('codex-switch 0.2.0'); return; }
    const pool = new Pool();
    const original = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
    if (command === 'list' || command === 'usage') {
      const json = flag(args, '--json');
      const all = flag(args, '--all');
      const name = args.shift(); none(args);
      if (name && all || command === 'list' && name) throw new Failure('Choose one account or --all.');
      const names = name ? [nameCheck(name)] : pool.names();
      const accounts = [];
      for (const n of names) accounts.push(command === 'usage' ? await probe(pool, n) : pool.get(n));
      show(accounts, pool.selected(), json, command === 'usage');
      if (command === 'usage' && accounts.some(a => !['ready', 'limited'].includes(a.state))) process.exitCode = 2;
    } else if (command === 'import') {
      const source = path.resolve(take(args, '--source-home') || original);
      const name = nameCheck(args.shift()); none(args);
      privateDir(pool.dir(name));
      const release = pool.accountLock(name);
      try {
        const a = pool.add(name, source, false);
        console.log(`Registered ${a.name} in place. Credentials were not copied.`);
      } finally { release(); }
    } else if (command === 'login') {
      const device = flag(args, '--device-auth');
      const name = nameCheck(args.shift()); none(args);
      const existing = pool.names().includes(name) ? pool.get(name) : null;
      if (existing && !existing.managed)
        throw new Failure('This account uses your original Codex home. Re-login there with codex login, then run usage.');
      privateDir(pool.dir(name));
      const home = existing?.home || path.join(pool.dir(name), 'codex-home');
      const release = pool.accountLock(name);
      let stage;
      try {
        if (!existing && pool.names().includes(name)) throw new Failure('Account was registered by another process; retry with its existing name.');
        stage = fs.mkdtempSync(path.join(pool.dir(name), '.login-'));
        prepareHome(pool, name, existing ? home : original, stage);
        const code = await native(stage, ['login', ...authArgs, ...(device ? ['--device-auth'] : [])], { cwd: stage });
        if (code !== 0) { process.exitCode = code; return; }
        if (existing) {
          if (credentialIdentity(stage).identity !== existing.identity)
            throw new Failure('You signed into a different account. Existing login preserved; use a new name to add that account.');
          fs.renameSync(path.join(stage, 'auth.json'), path.join(home, 'auth.json'));
          pool.save({ ...existing, state: 'unchecked', limits: undefined, checkedAt: undefined, error: undefined });
          console.log(`Login renewed for ${name}. Run codex-switch usage ${name}.`);
        } else {
          const a = pool.add(name, stage, true, { destination: home });
          console.log(`Registered ${a.name}. Run codex-switch usage ${a.name} to check quota.`);
        }
      } finally { if (stage) fs.rmSync(stage, { recursive: true, force: true }); release(); }
    } else if (command === 'use') {
      const name = nameCheck(args.shift()); none(args); pool.select(name);
      console.log(`Selected ${name} for codex-switch run. Existing sessions keep their account.`);
    } else if (command === 'status') {
      none(args);
      const status = readJSON(path.join(pool.root, 'live', 'status.json'), null);
      if (!status) { console.log('No live automatic session has been started.'); return; }
      let state = status.state;
      if (state !== 'stopped' && status.host === os.hostname()) {
        try { process.kill(status.pid, 0); } catch (e) { if (e.code === 'ESRCH') state = 'stale'; }
      }
      console.log(`Live auto: ${clean(state)}; account=${clean(status.active)}; remaining=${clean(status.remainingPercent)}%; threshold=${clean(status.minRemaining)}%; checked=${clean(status.checkedAt)}`);
      if (status.error) console.log(clean(status.error));
    } else if (command === 'run') {
      const sep = args.indexOf('--');
      const forwarded = sep < 0 ? [] : args.splice(sep).slice(1);
      const auto = flag(args, '--auto'); const specified = take(args, '--account');
      const rawMin = take(args, '--min-remaining');
      const rawInterval = take(args, '--poll-interval');
      const interval = rawInterval === undefined ? 30 : Number(rawInterval);
      const min = rawMin === undefined ? 10 : Number(rawMin); none(args);
      if (!Number.isFinite(min) || min < 0 || min > 100) throw new Failure('min-remaining must be between 0 and 100.');
      if (!Number.isInteger(interval) || interval < 5 || interval > 3600) throw new Failure('poll-interval must be an integer between 5 and 3600 seconds.');
      if (auto && specified || !auto && (rawMin !== undefined || rawInterval !== undefined)) throw new Failure('Use --auto with polling/threshold options, without --account.');
      // These options would invalidate account binding or target a different backend.
      if (forwarded.some(x => /^(--remote(?:=|$)|--oss$|--local-provider(?:=|$)|--profile(?:=|$)|-p)/.test(x)) ||
          forwarded.some(x => /^(?:[^=]+\.)?(cli_auth_credentials_store|forced_login_method|forced_chatgpt_workspace_id|model_providers?(?:\.[^=]+)?|chatgpt_base_url)\s*=/.test(x.replace(/^(--config=|-c=?)/, '').replaceAll('"', '').replaceAll("'", '').trim())) ||
          forwarded.some(x => ['login', 'logout', 'app-server', 'exec-server', 'remote-control'].includes(x)))
        throw new Failure('Account/backend overrides and auth commands are not supported through run.');
      if (auto) {
        const { runLive } = await import('./live.mjs');
        process.exitCode = await runLive(pool, forwarded, { minRemaining: min, interval });
        return;
      }
      const name = specified || pool.selected();
      if (!name) throw new Failure('No selected account. Run login or import first.');
      const a = pool.get(name);
      const release = pool.accountLock(a.name);
      try {
        if (credentialIdentity(a.home).identity !== a.identity) throw new Failure('Stored login identity changed; refusing to launch another account.');
        console.error(`codex-switch: ${a.name}`);
        process.exitCode = await native(a.home, [...authArgs, ...forwarded]);
      } finally { release(); }
    } else if (command === 'doctor') {
      none(args);
      console.log(`Pool: ${pool.root}\nNode: ${process.version}\nSelected: ${pool.selected() || '(none)'}`);
      for (const n of pool.names()) {
        try { const a = pool.get(n); const id = credentialIdentity(a.home); console.log(`${n}: ${id.identity === a.identity ? 'local credentials match (not a server check)' : 'IDENTITY CHANGED'}`); }
        catch (e) { console.log(`${n}: ${e instanceof Failure ? e.message : 'Local check failed'}`); process.exitCode = 2; }
      }
      const code = await native(original, ['--version']); if (code) process.exitCode = code;
    } else throw new Failure('Unknown command. See codex-switch --help.');
  } catch (e) {
    console.error(`codex-switch: ${e instanceof Failure ? e.message : 'Operation failed. Check storage permissions and local configuration.'}`);
    process.exitCode = e instanceof Failure && e.state === 'busy' ? 3 : e.state === 'interrupted' ? 130 : e.state === 'terminated' ? 143 : 1;
  }
}
