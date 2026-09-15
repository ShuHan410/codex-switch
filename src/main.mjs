import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { Pool, Failure, nameCheck, credentialIdentity, privateDir, prepareHome, native, authArgs, probe, buckets, headroom, readJSON } from './core.mjs';

const help = `codex-switch 0.4.0 — ChatGPT subscription accounts for Codex CLI

  login NAME [--device-auth]          Official login, then register account
  import NAME [--source-home PATH]    Copy an existing login into a managed home
  list [--json] [--codex-home PATH]   Accounts, cached quota, and native login marker
  usage [NAME | --all] [--json] [--codex-home PATH]  Check quota and native login
  use NAME [--codex-home PATH]        Replace native login and select account
  rename OLD_NAME NEW_NAME           Rename a registered account
  remove NAME                        Remove from pool; keep recoverable local data
  auto [--min-remaining PERCENT] [--poll-interval SECONDS] [--codex-home PATH] [--once]
                                     Monitor native login and replace auth.json
  run [--account NAME | --auto] [--min-remaining PERCENT] [--poll-interval SECONDS] [-- CODEX_ARGS...]
  status [--auto]                     Show live or native automatic-switch status
  doctor                             Check local setup without exposing tokens

Examples:
  codex-switch login second --device-auth
  codex-switch usage --all
  codex-switch use second
  codex-switch run -- --no-alt-screen
  codex-switch run --auto --min-remaining 15
  codex-switch run -- resume --last
  codex-switch auto

use replaces native auth.json and also selects the account for codex-switch run.
auto monitors native auth.json (5% / 30s) and replaces it; no session is launched.
Use status --auto to inspect it; Ctrl-C stops monitoring without undoing a switch.
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
function nativeLogin(pool, home) {
  try {
    const id = credentialIdentity(home);
    const match = pool.names().map(n => pool.get(n)).find(a => a.identity === id.identity);
    return { state: match ? 'registered' : 'unregistered', name: match?.name, email: id.email };
  } catch {
    let missing = false;
    try { fs.lstatSync(path.join(home, 'auth.json')); } catch (e) { missing = e.code === 'ENOENT'; }
    return { state: missing ? 'signed-out' : 'unknown' };
  }
}
function publicAccount(a, selected, native) {
  return { name: a.name, selected: a.name === selected, active: a.name === native.name,
    nativeState: native.state, email: a.email, state: a.state,
    plan: a.plan, checkedAt: a.checkedAt, error: a.error,
    remainingPercent: a.state === 'ready' || a.state === 'limited' ? headroom(a.limits) : null,
    limits: a.limits };
}
function show(accounts, selected, json, detail = false, native = { state: 'unknown' }) {
  if (json) { console.log(JSON.stringify(accounts.map(a => publicAccount(a, selected, native)), null, 2)); return; }
  console.log(`Native login: ${clean(native.email)} (${clean(native.name || native.state)})`);
  if (!accounts.length) { console.log('No accounts. Run: codex-switch login NAME'); return; }
  for (const a of accounts) {
    console.log(`${a.name === native.name ? '*' : ' '} ${a.name}  ${clean(a.email)}  ${clean(a.plan)}  ${a.state}  checked=${clean(a.checkedAt)}`);
    if (a.error) console.log(`    ${clean(a.error)}`);
    if (detail) for (const b of buckets(a.limits)) {
      for (const kind of ['primary', 'secondary']) {
        const w = b[kind]; if (!w) continue;
        const date = Number.isFinite(w.resetsAt) ? new Date(w.resetsAt * 1000) : null;
        const reset = date && Number.isFinite(date.getTime()) ? date.toLocaleString() : '?';
        const left = Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent <= 100 ? Number((100 - w.usedPercent).toFixed(6)) : '?';
        console.log(`    ${clean(b.limitId)} ${durationLabel(w.windowDurationMins)}: ${left}% left; resets=${reset}${a.state === 'busy' || a.state === 'unknown' || a.state === 'needs-login' ? ' (cached; not currently verified)' : ''}`);
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
    if (command === '--version') { console.log('codex-switch 0.4.0'); return; }
    const pool = new Pool();
    const original = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
    if (command === 'list' || command === 'usage') {
      const home = path.resolve(take(args, '--codex-home') || original);
      const json = flag(args, '--json');
      const all = flag(args, '--all');
      const name = args.shift(); none(args);
      if (name && all || command === 'list' && name) throw new Failure('Choose one account or --all.');
      const names = name ? [nameCheck(name)] : pool.names();
      const accounts = [];
      for (const n of names) accounts.push(command === 'usage' ? await probe(pool, n) : pool.get(n));
      show(accounts, pool.selected(), json, command === 'usage', nativeLogin(pool, home));
      if (command === 'usage' && accounts.some(a => !['ready', 'limited'].includes(a.state))) process.exitCode = 2;
    } else if (command === 'import') {
      const source = path.resolve(take(args, '--source-home') || original);
      const name = nameCheck(args.shift()); none(args);
      privateDir(pool.dir(name));
      const release = pool.accountLock(name);
      let stage;
      try {
        if (pool.names().includes(name)) throw new Failure('That account name is already registered.');
        const identity = credentialIdentity(source);
        stage = fs.mkdtempSync(path.join(pool.dir(name), '.import-'));
        prepareHome(pool, name, source, stage);
        const fd = fs.openSync(path.join(source, 'auth.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const s = fs.fstatSync(fd);
          if (!s.isFile() || s.uid !== process.getuid() || (s.mode & 0o077))
            throw new Failure('auth.json must be an owned regular file with mode 600.');
          fs.writeFileSync(path.join(stage, 'auth.json'), fs.readFileSync(fd), { mode: 0o600, flag: 'wx' });
        } finally { fs.closeSync(fd); }
        if (credentialIdentity(stage).identity !== identity.identity || credentialIdentity(source).identity !== identity.identity)
          throw new Failure('Source login changed during import; retry after login completes.');
        const a = pool.add(name, stage, true, { destination: pool.newHome(name) });
        console.log(`Imported ${a.name} into independent managed storage. Source login unchanged. Run codex-switch usage ${a.name}.`);
      } finally { if (stage) fs.rmSync(stage, { recursive: true, force: true }); release(); }
    } else if (command === 'login') {
      const device = flag(args, '--device-auth');
      const name = nameCheck(args.shift()); none(args);
      let existing = pool.names().includes(name) ? pool.get(name) : null;
      if (existing && !existing.managed)
        throw new Failure('This account uses your original Codex home. Re-login there with codex login, then run usage.');
      privateDir(pool.dir(name));
      const home = existing?.home || pool.newHome(name);
      const release = pool.accountLock(name);
      let stage;
      try {
        if (!existing && pool.names().includes(name)) throw new Failure('Account was registered by another process; retry with its existing name.');
        if (existing) existing = pool.revalidate(existing);
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
    } else if (command === 'rename') {
      const name = nameCheck(args.shift()); const next = nameCheck(args.shift()); none(args);
      pool.rename(name, next);
      console.log(`Renamed ${name} to ${next}. Credentials and native login unchanged.`);
    } else if (command === 'remove') {
      const name = nameCheck(args.shift()); none(args);
      const archive = pool.remove(name);
      console.log(`Removed ${name} from the pool. Native login unchanged. Credentials/history retained; recovery record: ${archive}`);
    } else if (command === 'use') {
      const home = path.resolve(take(args, '--codex-home') || original);
      const name = nameCheck(args.shift()); none(args);
      const { useNative } = await import('./auto.mjs');
      const target = useNative(pool, home, name);
      console.log(`Native login set to ${name}: ${target}/auth.json. Default selection updated; running sessions are not checked.`);
    } else if (command === 'auto') {
      const rawMin = take(args, '--min-remaining');
      const rawInterval = take(args, '--poll-interval');
      const home = path.resolve(take(args, '--codex-home') || original);
      const once = flag(args, '--once'); none(args);
      const minRemaining = rawMin === undefined ? 5 : Number(rawMin);
      const interval = rawInterval === undefined ? 30 : Number(rawInterval);
      if (!Number.isFinite(minRemaining) || minRemaining < 0 || minRemaining > 100)
        throw new Failure('min-remaining must be between 0 and 100.');
      if (!Number.isInteger(interval) || interval < 5 || interval > 3600)
        throw new Failure('poll-interval must be an integer between 5 and 3600 seconds.');
      const { runAuto } = await import('./auto.mjs');
      await runAuto(pool, home, { minRemaining, interval, once });
    } else if (command === 'status') {
      const auto = flag(args, '--auto');
      none(args);
      const status = readJSON(path.join(pool.root, auto ? 'auto' : 'live', 'status.json'), null);
      if (!status) { console.log(`No ${auto ? 'native monitor' : 'live automatic session'} has been started.`); return; }
      let state = status.state;
      if (state !== 'stopped' && status.host === os.hostname()) {
        try { process.kill(status.pid, 0); } catch (e) { if (e.code === 'ESRCH') state = 'stale'; }
      }
      console.log(`${auto ? 'Native auto' : 'Live auto'}: ${clean(state)}; account=${clean(status.active)}; remaining=${clean(status.remainingPercent)}%; threshold=${clean(status.minRemaining)}%; checked=${clean(status.checkedAt)}`);
      if (auto) console.log(`Home: ${clean(status.home)}; last=${clean(status.lastState || status.state)}`);
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
        pool.revalidate(a);
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
