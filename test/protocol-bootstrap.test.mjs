import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

test('protocol verifier routes bootstrap requests to its local synthetic service', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-bootstrap-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const probe = path.join(root, 'probe.mjs');
  const report = path.join(root, 'report.json');
  // Probe only the startup configuration and actual HTTP fixture. No RPC success
  // is fabricated; this child exits before opening an app-server socket.
  fs.writeFileSync(probe, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const settings = process.argv.slice(2);
const value = key => settings.find(arg => arg.startsWith(key + '='))?.slice(key.length + 1);
let stage = 'local bootstrap configuration';
try {
  const backend = new URL(JSON.parse(value('chatgpt_base_url')));
  assert.equal(backend.hostname, '127.0.0.1');
  assert.equal(backend.protocol, 'http:');
  assert.equal(backend.pathname, '/backend-api/');
  const model = value('model_providers.fixture');
  assert.ok(model.includes('base_url=' + JSON.stringify(backend.origin + '/v1')));
  assert.ok(model.includes('name="Local synthetic fixture"'));
  for (const name of ['alpha', 'beta']) {
    stage = name + ' bootstrap responses';
    const auth = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, '..', name, 'auth.json'), 'utf8'));
    const headers = { authorization: 'Bearer ' + auth.tokens.access_token, 'chatgpt-account-id': name };
    const response = await fetch(new URL('wham/accounts/check', backend), { headers });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accounts: [{ id: name,
      workspace_backend_origin: 'https://fixture.invalid', account_routing_override: 'NO_CONSTRAINT' }] });
    const config = await fetch(new URL('wham/config/bundle', backend), { headers });
    assert.equal(config.status, 200);
    assert.deepEqual(await config.json(), { requirements_toml: {} });
    const mismatch = await fetch(new URL('wham/accounts/check', backend), {
      headers: { ...headers, 'chatgpt-account-id': name === 'alpha' ? 'beta' : 'alpha' },
    });
    assert.equal(mismatch.status, 401);
  }
  stage = 'unknown requests rejected';
  const anonymous = await fetch(new URL('wham/accounts/check', backend));
  assert.equal(anonymous.status, 401);
  const unknown = await fetch(new URL('unexpected', backend));
  assert.equal(unknown.status, 404);
  fs.writeFileSync(process.env.CODEX_SWITCH_BOOTSTRAP_REPORT, JSON.stringify({ passed: true }));
} catch {
  fs.writeFileSync(process.env.CODEX_SWITCH_BOOTSTRAP_REPORT, JSON.stringify({ passed: false, stage }));
}
`, { mode: 0o700 });
  const child = spawn(process.execPath, ['scripts/verify-live-protocol.mjs'], {
    env: { ...process.env, TMPDIR: root, CODEX_SWITCH_CODEX: probe, CODEX_SWITCH_BOOTSTRAP_REPORT: report },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', resolve);
  }).finally(() => clearTimeout(timer));
  assert.equal(code, 1); // Intentional stop before the real-CLI protocol check.
  assert.match(output, /Synthetic server startup failed/);
  assert.deepEqual(JSON.parse(fs.readFileSync(report, 'utf8')), { passed: true });
  assert.doesNotMatch(output, /"passed":true/);
});
