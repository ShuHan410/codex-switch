import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { localTime, paint, quotaTone, accountBadge } from './display.mjs';
import { Pool, Failure, nameCheck, credentialIdentity, privateDir, prepareHome, native, authArgs, probe, buckets, headroom, mapConcurrent, readJSON } from './core.mjs';

const USAGE_CONCURRENCY = 2;

const commandUsage = {
  login: 'codex-switch login NAME [--device-auth]',
  import: 'codex-switch import NAME [--source-home PATH]',
  rename: 'codex-switch rename OLD_NAME NEW_NAME',
  remove: 'codex-switch remove NAME',
  list: 'codex-switch list [--json] [--codex-home PATH]',
  usage: 'codex-switch usage [NAME | --all] [--json] [--codex-home PATH]',
  use: 'codex-switch use NAME [--codex-home PATH]',
  auto: 'codex-switch auto [--min-remaining PERCENT] [--poll-interval SECONDS] [--codex-home PATH] [--once]',
  status: 'codex-switch status [--auto]',
  run: 'codex-switch run [--account NAME | --auto] [--min-remaining PERCENT] [--poll-interval SECONDS] [-- ARGS...]',
  doctor: 'codex-switch doctor',
};

const help = `codex-switch 0.4.0 — ChatGPT subscription accounts for Codex CLI

ACCOUNTS
  login NAME [--device-auth]         Official login, then register account
  import NAME [--source-home PATH]   Copy an existing login into a managed home
  rename OLD_NAME NEW_NAME           Rename a registered account
  remove NAME                       Remove from pool; retain local data

CHECK & SWITCH
  list                              Accounts and actual native login marker
  usage [NAME | --all]               Remaining quota (5h / 7d, % left)
  use NAME                          Replace native login and select account
    list / usage: --json             Machine-readable output
    list / usage / use: --codex-home PATH

NATIVE MONITOR — for your regular codex terminal
  auto                              Monitor and switch native auth.json
    --min-remaining PERCENT          Default: 5; switch below this threshold
    --poll-interval SECONDS          Default: 30
    --codex-home PATH                Override native home
    --once                          One check; may switch the account
  status --auto                     Inspect the native monitor

SESSIONS
  run [--account NAME] [-- CODEX_ARGS...]
                                    Launch with a separate account home
  run --auto [--min-remaining PERCENT] [--poll-interval SECONDS]
      [-- CODEX_ARGS...]             Experimental live switching (10% / 30s)
  status                            Inspect the experimental live session
  doctor                            Check local setup without exposing tokens

QUICK START
  codex-switch import personal
  codex-switch usage --all
  codex-switch use personal
  codex

NOTES
  use / auto update the login file; existing sessions are not checked.
  auto stays quiet. Ctrl-C stops it without undoing a switch.
  run --auto shares a dedicated live home; manual runs keep per-account history.
  CODEX_HOME overrides native home (default: ~/.codex).
  CODEX_SWITCH_HOME overrides pool storage; CODEX_SWITCH_CODEX the executable.
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
  console.log(`Run default: ${clean(selected)}\n`);
  if (!accounts.length) {
    console.log('No accounts in your pool yet.\n\n  Save current login   codex-switch import NAME\n  Sign in another      codex-switch login NAME');
    return;
  }
  const nameWidth = Math.max(7, ...accounts.map(a => clean(a.name).length));
  const planWidth = Math.max(4, ...accounts.map(a => clean(a.plan).length));
  console.log(`  ${'ACCOUNT'.padEnd(nameWidth)}  ${'PLAN'.padEnd(planWidth)}  STATUS`);
  console.log(`  ${'-'.repeat(nameWidth)}  ${'-'.repeat(planWidth)}  ----------------`);
  for (const a of accounts) {
    const badge = accountBadge(a, headroom(a.limits));
    const marker = a.name === native.name ? paint('*', 'active') : ' ';
    console.log(`${marker} ${clean(a.name).padEnd(nameWidth)}  ${clean(a.plan).padEnd(planWidth)}  ${paint(`${clean(a.state)} [${badge.label}]`, badge.tone)}`);
    console.log(`    ${clean(a.email)}\n    Checked: ${localTime(a.checkedAt)}`);
    if (a.error) console.log(`    Note: ${clean(a.error)}`);
    let windows = 0;
    if (detail) for (const b of buckets(a.limits)) {
      for (const kind of ['primary', 'secondary']) {
        const w = b[kind]; if (!w) continue;
        windows++;
        const reset = localTime(Number.isFinite(w.resetsAt) ? w.resetsAt * 1000 : undefined);
        const left = Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent <= 100 ? Number((100 - w.usedPercent).toFixed(6)) : '?';
        console.log(`    ${durationLabel(w.windowDurationMins).padEnd(8)} ${paint(`${left}% left`.padStart(12), badge.verified ? quotaTone(left) : 'muted')}  ${clean(b.limitId)}`);
        console.log(`      Resets: ${reset}${!badge.verified ? ' (cached; not currently verified)' : ''}`);
      }
    }
    if (detail && !windows) console.log('    Quota: not available');
    console.log('');
  }
  console.log('Marker: * = native login file match; run default is separate.');
  if (!detail) console.log('Check remaining quota: codex-switch usage --all');
}
class CliFailure extends Failure {
  constructor(message, command, hint) {
    super(message);
    this.usage = commandUsage[command];
    this.hint = hint;
  }
}
function quoted(value) { return JSON.stringify(clean(value)); }
function nameRule(label) { return `${label} must be 1–48 letters, digits, underscores, or hyphens.`; }
function looksLikeOption(value) { return value.startsWith('-'); }
function requiredName(args, command, label = 'NAME') {
  const value = args.shift();
  if (value === undefined) throw new CliFailure(`missing required argument: ${label}`, command, nameRule(label));
  if (looksLikeOption(value)) throw new CliFailure(`unknown option: ${value}`, command);
  try { return nameCheck(value); }
  catch (e) {
    if (!(e instanceof Failure)) throw e;
    throw new CliFailure(`invalid ${label}: ${quoted(value)}`, command, nameRule(label));
  }
}
function optionalName(value, command, label = 'NAME') {
  if (value === undefined) return undefined;
  if (looksLikeOption(value)) throw new CliFailure(`unknown option: ${value}`, command);
  try { return nameCheck(value); }
  catch (e) {
    if (!(e instanceof Failure)) throw e;
    throw new CliFailure(`invalid ${label}: ${quoted(value)}`, command, nameRule(label));
  }
}
function take(args, option, command, valueLabel) {
  const i = args.indexOf(option);
  if (i < 0) return undefined;
  if (!args[i + 1] || args[i + 1].startsWith('--'))
    throw new CliFailure(`option ${option} requires ${valueLabel}`, command);
  const value = args[i + 1]; args.splice(i, 2); return value;
}
function flag(args, name) { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; }
function none(args, command) {
  if (!args.length) return;
  const value = args[0];
  throw new CliFailure(looksLikeOption(value) ? `unknown option: ${value}` : `unexpected argument: ${quoted(value)}`, command);
}

export async function main(argv = process.argv.slice(2)) {
  process.umask(0o077);
  try {
    const args = [...argv]; const command = args.shift();
    if (!command || ['help', '--help', '-h'].includes(command)) { console.log(help); return; }
    if (command === '--version') { console.log('codex-switch 0.4.0'); return; }
    const pool = new Pool();
    const original = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
    if (command === 'list' || command === 'usage') {
      const home = path.resolve(take(args, '--codex-home', command, 'PATH') || original);
      const json = flag(args, '--json');
      const all = command === 'usage' ? flag(args, '--all') : false;
      let name;
      if (command === 'list') none(args, command);
      else { name = args.shift(); none(args, command); }
      if (name && all) throw new CliFailure('choose either NAME or --all, not both', command);
      name = optionalName(name, command);
      const names = name ? [name] : pool.names();
      const accounts = command === 'usage'
        ? await mapConcurrent(names, USAGE_CONCURRENCY, n => probe(pool, n))
        : names.map(n => pool.get(n));
      show(accounts, pool.selected(), json, command === 'usage', nativeLogin(pool, home));
      if (command === 'usage' && accounts.some(a => !['ready', 'limited'].includes(a.state))) process.exitCode = 2;
    } else if (command === 'import') {
      const source = path.resolve(take(args, '--source-home', command, 'PATH') || original);
      const name = requiredName(args, command); none(args, command);
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
      const name = requiredName(args, command); none(args, command);
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
      const name = requiredName(args, command, 'OLD_NAME');
      const next = requiredName(args, command, 'NEW_NAME'); none(args, command);
      pool.rename(name, next);
      console.log(`Renamed ${name} to ${next}. Credentials and native login unchanged.`);
    } else if (command === 'remove') {
      const name = requiredName(args, command); none(args, command);
      const archive = pool.remove(name);
      console.log(`Removed ${name} from the pool. Native login unchanged. Credentials/history retained; recovery record: ${archive}`);
    } else if (command === 'use') {
      const home = path.resolve(take(args, '--codex-home', command, 'PATH') || original);
      const name = requiredName(args, command); none(args, command);
      const { useNative } = await import('./auto.mjs');
      const target = useNative(pool, home, name);
      console.log(`Native login set to ${name}: ${target}/auth.json. Default selection updated; running sessions are not checked.`);
    } else if (command === 'auto') {
      const rawMin = take(args, '--min-remaining', command, 'PERCENT');
      const rawInterval = take(args, '--poll-interval', command, 'SECONDS');
      const home = path.resolve(take(args, '--codex-home', command, 'PATH') || original);
      const once = flag(args, '--once'); none(args, command);
      const minRemaining = rawMin === undefined ? 5 : Number(rawMin);
      const interval = rawInterval === undefined ? 30 : Number(rawInterval);
      if (!Number.isFinite(minRemaining) || minRemaining < 0 || minRemaining > 100)
        throw new CliFailure(`invalid value for --min-remaining: ${quoted(rawMin)}`, command, 'PERCENT must be between 0 and 100.');
      if (!Number.isInteger(interval) || interval < 5 || interval > 3600)
        throw new CliFailure(`invalid value for --poll-interval: ${quoted(rawInterval)}`, command, 'SECONDS must be an integer between 5 and 3600.');
      const { runAuto } = await import('./auto.mjs');
      await runAuto(pool, home, { minRemaining, interval, once });
    } else if (command === 'status') {
      const auto = flag(args, '--auto');
      none(args, command);
      const status = readJSON(path.join(pool.root, auto ? 'auto' : 'live', 'status.json'), null);
      if (!status) { console.log(`No ${auto ? 'native monitor' : 'live automatic session'} has been started.`); return; }
      let state = status.state;
      if (state !== 'stopped' && status.host === os.hostname()) {
        try { process.kill(status.pid, 0); } catch (e) { if (e.code === 'ESRCH') state = 'stale'; }
      }
      console.log(`${auto ? 'Native auto' : 'Live auto'}: ${clean(state)}; account=${clean(status.active)}\n`);
      console.log(`  Remaining  ${clean(status.remainingPercent)}% left\n  Threshold  ${clean(status.minRemaining)}%\n  Checked    ${localTime(status.checkedAt)}`);
      if (auto) console.log(`  Home       ${clean(status.home)}\n  Last event ${clean(status.lastState || status.state)}`);
      if (status.error) console.log(`  Note       ${clean(status.error)}`);
    } else if (command === 'run') {
      const sep = args.indexOf('--');
      const forwarded = sep < 0 ? [] : args.splice(sep).slice(1);
      const auto = flag(args, '--auto'); const specified = take(args, '--account', command, 'NAME');
      const rawMin = take(args, '--min-remaining', command, 'PERCENT');
      const rawInterval = take(args, '--poll-interval', command, 'SECONDS');
      const interval = rawInterval === undefined ? 30 : Number(rawInterval);
      const min = rawMin === undefined ? 10 : Number(rawMin); none(args, command);
      if (!Number.isFinite(min) || min < 0 || min > 100)
        throw new CliFailure(`invalid value for --min-remaining: ${quoted(rawMin)}`, command, 'PERCENT must be between 0 and 100.');
      if (!Number.isInteger(interval) || interval < 5 || interval > 3600)
        throw new CliFailure(`invalid value for --poll-interval: ${quoted(rawInterval)}`, command, 'SECONDS must be an integer between 5 and 3600.');
      if (auto && specified || !auto && (rawMin !== undefined || rawInterval !== undefined))
        throw new CliFailure('use --auto with polling/threshold options, without --account', command);
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
      none(args, command);
      console.log(`Pool: ${pool.root}\nNode: ${process.version}\nSelected: ${pool.selected() || '(none)'}`);
      for (const n of pool.names()) {
        try { const a = pool.get(n); const id = credentialIdentity(a.home); console.log(`${n}: ${id.identity === a.identity ? 'local credentials match (not a server check)' : 'IDENTITY CHANGED'}`); }
        catch (e) { console.log(`${n}: ${e instanceof Failure ? e.message : 'Local check failed'}`); process.exitCode = 2; }
      }
      const code = await native(original, ['--version']); if (code) process.exitCode = code;
    } else throw new Failure(`Unknown command: ${quoted(command)}. Run codex-switch --help to list commands.`);
  } catch (e) {
    const message = e instanceof Failure ? e.message : 'Operation failed. Check storage permissions and local configuration.';
    console.error(`codex-switch: ${paint('Error:', 'bad', process.stderr)} ${message}${e instanceof CliFailure && e.usage ? `\n\nUsage:\n  ${e.usage}` : ''}${e instanceof CliFailure && e.hint ? `\n\n${e.hint}` : ''}`);
    process.exitCode = e instanceof Failure && e.state === 'busy' ? 3 : e.state === 'interrupted' ? 130 : e.state === 'terminated' ? 143 : 1;
  }
}
