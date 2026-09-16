// Presentation only: never persist formatted dates or ANSI sequences.
export function localTime(value) {
  if (value === undefined || value === null || value === '') return '-';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '-';
  const pad = n => String(n).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ` +
    `${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

export function paint(text, tone, stream = process.stdout, env = process.env) {
  if (!stream.isTTY || Object.hasOwn(env, 'NO_COLOR') || env.TERM === 'dumb') return text;
  const codes = { good: '32', low: /256color|truecolor|24bit/i.test(`${env.TERM} ${env.COLORTERM}`) ? '38;5;208' : '33', bad: '31', muted: '90', active: '36' };
  return codes[tone] ? `\x1b[${codes[tone]}m${text}\x1b[0m` : text;
}

export function quotaTone(left) {
  if (!Number.isFinite(left) || left < 0 || left > 100) return 'muted';
  return left === 0 ? 'bad' : left < 5 ? 'low' : 'good';
}

export function accountBadge(account, remaining, now = Date.now()) {
  if (account.state === 'needs-login') return { tone: 'bad', label: 'LOGIN REQUIRED', verified: false };
  const age = now - Date.parse(account.checkedAt);
  const verified = ['ready', 'limited'].includes(account.state) && Number.isFinite(age) && age >= 0 && age < 60000;
  if (!verified) return { tone: 'muted', label: account.checkedAt ? 'UNVERIFIED / CACHED' : 'UNVERIFIED', verified: false };
  const tone = quotaTone(remaining);
  return { tone, label: { good: 'OK', low: 'LOW <5%', bad: 'EMPTY', muted: 'UNKNOWN' }[tone], verified: tone !== 'muted' };
}
