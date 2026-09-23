// Fixture-only diagnostics. Never print arbitrary server text, even with fake
// credentials: inherited environment and remote error bodies may be sensitive.
// Fixed phrases observed in the installed Codex 0.156.1 binary identify reported
// stages/symptoms, not proven causes. Unknown text always remains redacted.
const phrases = [
  'Failed to resolve external auth:',
  'failed to refresh token while getting account:',
  'failed to get token for auth status:',
  'failed to set external auth:',
  'Failed to refresh token:',
  'Invalid JWT format while extracting claims',
  'Missing required claim:',
  'external auth is not configured',
  'external ChatGPT auth tokens are missing auth state',
  'Token data is not available.',
  'Your access token could not be refreshed. Please log out and sign in again.',
  'account changed during workspace routing discovery',
  'workspace routing owner is unavailable',
  'failed to load workspace requirements',
  'workspace routing requires a ChatGPT account id',
  'workspace routing discovery cancelled',
  'workspace routing discovery cancelled during shutdown',
  'workspace routing discovery unauthorized (401)',
  'workspace routing discovery failed',
  'selected workspace missing from routing discovery',
  'duplicate workspace in routing discovery',
  'failed to reload workspace requirements',
  'configuration changed during workspace routing discovery; retry account/read',
  'invalid model provider URL',
  'invalid ChatGPT backend URL',
  'invalid session ChatGPT backend URL',
  'ChatGPT backend changed; start a new thread before sending more content',
  'workspace routing discovery timed out',
  'workspace routing discovery missing backend origin',
  'workspace routing discovery has invalid account routing override',
  'workspace routing discovery must return an origin',
  'required ChatGPT backend conflicts with workspace routing',
  'invalid workspace backend URL',
  'workspace backend must use an HTTPS origin without credentials',
  'error sending request',
  'error decoding response body',
];

export function traceRpcResponse(message, trace) {
  if (!message || typeof message !== 'object' || Array.isArray(message)
    || message.method || message.id === undefined) return;
  const id = Number.isSafeInteger(message.id) ? String(message.id)
    : typeof message.id === 'string' && /^\d{1,12}$/.test(message.id)
      ? `string:${message.id}` : 'redacted';
  const hasError = Boolean(message.error); // Match SocketRpc's response handling.
  trace(`server response id=${id} (${hasError ? 'error' : 'result'})`);
  if (!hasError) return;
  const error = message.error;
  const text = typeof error?.message === 'string' ? error.message : '';
  // Only explicitly labeled HTTP statuses; never arbitrary numbers in tokens.
  const status = text.match(/\b(?:HTTP status (?:client|server) error \(|(?:HTTP(?: status(?: code)?)?|status code)[:= ]+)([1-5]\d{2})\b/i);
  const data = error?.data;
  trace(`server error ${JSON.stringify({
    code: Number.isSafeInteger(error?.code) ? error.code : null,
    messagePhrases: phrases.filter(phrase => text.includes(phrase)),
    messageMatch: phrases.includes(text) ? 'exact' : 'partial-or-unrecognized',
    httpStatus: status ? Number(status[1]) : null,
    dataType: data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data,
    details: 'redacted',
  })}`);
}
