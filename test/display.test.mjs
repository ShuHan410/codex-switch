import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { localTime, paint, quotaTone, accountBadge } from '../src/display.mjs';

test('local dates use requested system timezone, offset and DST without milliseconds', () => {
  const module = new URL('../src/display.mjs', import.meta.url).href;
  for (const [tz, input, expected] of [
    ['Asia/Taipei', '2026-09-16T06:19:40.471Z', '2026-09-16 14:19:40 +08:00'],
    ['UTC', '2026-09-16T06:19:40.471Z', '2026-09-16 06:19:40 +00:00'],
    ['Asia/Kolkata', '2026-09-16T06:19:40.471Z', '2026-09-16 11:49:40 +05:30'],
    ['Asia/Kathmandu', '2026-09-16T06:19:40.471Z', '2026-09-16 12:04:40 +05:45'],
    ['America/New_York', '2026-01-16T06:19:40.471Z', '2026-01-16 01:19:40 -05:00'],
    ['America/New_York', '2026-07-16T06:19:40.471Z', '2026-07-16 02:19:40 -04:00'],
  ]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import { localTime } from ${JSON.stringify(module)}; console.log(localTime(${JSON.stringify(input)}));`], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), expected);
  }
  for (const input of [undefined, null, '', 'invalid', NaN]) assert.equal(localTime(input), '-');
});

test('colors require TTY and respect NO_COLOR and dumb terminals', () => {
  assert.equal(paint('OK', 'good', { isTTY: true }, { TERM: 'xterm' }), '\x1b[32mOK\x1b[0m');
  assert.equal(paint('LOW', 'low', { isTTY: true }, { TERM: 'xterm' }), '\x1b[33mLOW\x1b[0m');
  assert.equal(paint('LOW', 'low', { isTTY: true }, { TERM: 'xterm-256color' }), '\x1b[38;5;208mLOW\x1b[0m');
  for (const [stream, env] of [[{}, {}], [{ isTTY: false }, { FORCE_COLOR: '1' }], [{ isTTY: true }, { NO_COLOR: '1' }], [{ isTTY: true }, { NO_COLOR: '' }], [{ isTTY: true }, { TERM: 'dumb' }]]) {
    assert.equal(paint('OK', 'good', stream, env), 'OK');
  }
});

test('health badges distinguish low, empty, login required and stale or unknown data', () => {
  const now = Date.now();
  const a = { state: 'ready', checkedAt: new Date(now).toISOString() };
  for (const [left, tone] of [[80, 'good'], [5, 'good'], [4.99, 'low'], [0, 'bad'], [null, 'muted'], [NaN, 'muted'], [-1, 'muted']]) {
    assert.equal(quotaTone(left), tone); assert.equal(accountBadge(a, left, now).tone, tone);
  }
  for (const state of ['busy', 'unknown', 'unchecked', 'identity-changed']) assert.equal(accountBadge({ ...a, state }, 80, now).verified, false);
  assert.equal(accountBadge({ ...a, state: 'needs-login' }, 80, now).label, 'LOGIN REQUIRED');
  for (const checkedAt of [undefined, 'bad', new Date(now - 60000).toISOString(), new Date(now + 1).toISOString()]) assert.equal(accountBadge({ ...a, checkedAt }, 80, now).tone, 'muted');
  assert.equal(accountBadge(a, null, now).verified, false);
});
