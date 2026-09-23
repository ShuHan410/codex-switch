import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { SocketRpc } from '../src/live.mjs';
import { traceRpcResponse } from '../scripts/protocol-diagnostics.mjs';

test('protocol diagnostics disclose only fixed error phrases and numeric fields', () => {
  const lines = [];
  traceRpcResponse({ id: 3, error: { code: -32603,
    message: 'Failed to resolve external auth: HTTP status client error (401 Unauthorized) for url (https://example.test/secret-token) user@example.test /private/path\nINJECTED',
    data: { accessToken: 'secret-token', message: 'INJECTED' },
  } }, line => lines.push(line));
  assert.deepEqual(JSON.parse(lines[1].slice('server error '.length)), {
    code: -32603, messagePhrases: ['Failed to resolve external auth:'],
    messageMatch: 'partial-or-unrecognized',
    httpStatus: 401, dataType: 'object', details: 'redacted',
  });
  assert.equal(lines[0], 'server response id=3 (error)');
  assert.doesNotMatch(lines.join('\n'), /secret-token|example\.test|private\/path|INJECTED/);
});

test('workspace-routing errors are recognized as exact static messages without exposing suffixes', () => {
  for (const suffix of ['', ': secret-token user@example.test']) {
    const lines = [];
    traceRpcResponse({ id: 3, error: { code: -32603,
      message: `workspace routing discovery unauthorized (401)${suffix}`,
    } }, line => lines.push(line));
    const error = JSON.parse(lines[1].slice('server error '.length));
    assert.deepEqual(error.messagePhrases, ['workspace routing discovery unauthorized (401)']);
    assert.equal(error.messageMatch, suffix ? 'partial-or-unrecognized' : 'exact');
    assert.doesNotMatch(lines.join('\n'), /secret-token|example\.test/);
  }
});

test('unknown and malformed diagnostics fail closed, including response IDs', () => {
  for (const error of [true, 'secret', [], { code: 'secret', message: 'secret 401', data: 'secret' }]) {
    const lines = [];
    traceRpcResponse({ id: 'secret', error }, line => lines.push(line));
    assert.doesNotMatch(lines.join('\n'), /secret|401/);
    assert.equal(lines.length, 2);
    assert.match(lines[1], /"messagePhrases":\[\]/);
  }
  const lines = [];
  traceRpcResponse({ id: '3', error: null, result: { accessToken: 'secret' } }, line => lines.push(line));
  traceRpcResponse({ id: 9, method: 'secret', error: { message: 'secret' } }, line => lines.push(line));
  assert.deepEqual(lines, ['server response id=string:3 (result)']);
});

test('real SocketRpc still rejects with a sanitized error while fixture trace receives code', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-diagnostics-'));
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const socket = path.join(root, 'rpc.sock');
  wss.on('connection', ws => ws.on('message', data => {
    const msg = JSON.parse(data.toString());
    ws.send(JSON.stringify({ id: msg.id, error: { code: -32603,
      message: 'failed to refresh token while getting account: secret-token', data: 'secret-token' } }));
  }));
  let rpc;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
    rpc = new SocketRpc(socket, 1000);
    const lines = [];
    rpc.ws.on('message', data => traceRpcResponse(JSON.parse(data.toString()), line => lines.push(line)));
    await rpc.opened;
    await assert.rejects(rpc.request('account/read', { refreshToken: false }), {
      message: 'Codex service request failed; automatic switching is paused.',
    });
    assert.match(lines[1], /"code":-32603/);
    assert.match(lines[1], /failed to refresh token while getting account:/);
    assert.doesNotMatch(lines.join('\n'), /secret-token/);
  } finally {
    rpc?.close();
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
