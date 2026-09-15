# Native use fix (0.3.1) — 2026-09-15

Bug: `use NAME` only called `pool.select`, leaving native auth.json unchanged.
It now uses the same `switchNative` credential commit routine as `auto`, with
native-home and affected-account locks. Manual selection has no quota gate.
Existing native credentials are backed up; registered outgoing credentials are
saved back to their managed home; native auth and default selection are updated.
Selecting the already active identity preserves the native token unchanged.

`npm test`: exit 0, 39 passed, 0 failed. Three added CLI regressions check real
synthetic native-file changes (not merely the selection pointer), preserved
settings/history and backups, same-identity token preservation, missing or
unregistered native login, explicit home override, and refusal while locked.
All existing auto/import/live tests remain passing after sharing the switch path.
No real account was switched during development; no existing session behavior
is claimed. File-login/refresh-race limitations below still apply.

# Native login monitor (0.3.0) — 2026-09-15

Acceptance: B-terminal `codex-switch auto` immediately checks the native
file-login account, then waits 30 seconds between rounds. Below 5% remaining,
select a fresh, managed alternative with at least 5%, preserve outgoing
credentials, atomically replace native auth.json, and update default selection.
No session launch/attachment, notifications, restart, resume, or replay.

- `npm test`: exit 0, 36 passed, 0 failed. Twelve new synthetic tests cover
  actual native identity rather than selected pointer, native-home RPC routing,
  file replacement and next-round identity, untouched config/history, recoverable
  backups and permissions, exact threshold, unknown/unregistered/no alternative,
  busy account, outside login changes, candidate identity changes, coalescing,
  CLI `auto --once` + `status --auto`, singleton locks and SIGTERM cleanup.
- Independent review identified a detectable external-login race during backup
  work. A new synthetic regression reproduced it (exit 1 before the fix);
  both credential writes now happen only after the post-backup native recheck.
- `codex-switch --version`: exit 0, `codex-switch 0.3.0`.
- `node --check src/auto.mjs`, `src/core.mjs`, `src/main.mjs`: exit 0.
- `git diff --check`: exit 0.

The credential parser now validates an owned, private, regular descriptor opened
with O_NOFOLLOW/O_NONBLOCK before reading, including both identity and text from
the same snapshot. Existing import/manual/live tests remain in the suite.

No real native credentials were replaced and no persistent monitor was started
during development. The CLI integration test invokes a local fake Codex quota
service and asserts actual synthetic files, not just a selected-account label.
External token refresh/revocation and quota services are not simulated as proof
of continued authorization. Ordinary Codex does not honor tool locks; there is
an unavoidable final read-to-rename race with concurrent external login/refresh.
No claim about existing sessions adopting the new credentials is made, as
explicitly excluded by the owner. Keyring/backend/admin policy changes are out
of scope: only the selected native file-login location is managed.

# Managed import (0.2.1) — 2026-09-15

`import NAME [--source-home PATH]` now stages a private credential snapshot and
registers a managed home using the same commit path as `login`. Source credentials
are never rewritten or removed; source sessions are not stopped. Existing names
and duplicate identities are refused, not overwritten. Historical unmanaged
imports are unchanged (no implicit migration).

`npm test`: exit 0, 24 passed, 0 failed. New synthetic tests cover source
preservation, independent credentials after source login replacement, managed
login renewal, mode 600, duplicate cleanup, and insecure-source refusal. Native
run binding now checks the independent imported home rather than the old source.
`codex-switch --version`: exit 0, `codex-switch 0.2.1`.

No real credentials were imported during development. Live validity and concurrent
refresh-token behavior are not established by an offline snapshot; copied and
source credentials initially share an authorization. Production seamless-switch
acceptance remains deferred by the owner. A fresh official login is still needed
if that authorization becomes invalid.

# V2 verification — 2026-09-15

Environment: Linux, Node v25.8.2, codex-cli 0.154.0, ws 8.21.3.

Acceptance: switch the active conversation automatically below the configured
remaining-quota threshold, without reminders, restarting, or replaying work;
preserve each account's canonical credentials and existing manual commands.

- `npm test`: exit 0; 21 passed, 0 failed. Includes the 13 V1 regressions and
  eight live-controller tests: same-email workspace refusal, threshold boundaries, unknown quota, unavailable
  alternatives, leases, refresh identity, ambiguous login, outside login changes,
  overlapping polls, and candidate rechecks. All credentials are synthetic.
  An earlier run exceeded the JSON-noise fixture's 100 ms process-start budget
  and leaked its child on assertion failure; this fixture now has a 1 s budget
  and unconditional cleanup. The separate timeout-rejection test is unchanged.
- `node scripts/verify-live-protocol.mjs`: exit 0. A real installed Codex App
  Server sends two model requests in the same thread to a localhost SSE fixture.
  Lowering alpha's simulated headroom to 5% triggers beta automatically; captured
  request identities are exactly `["alpha","beta"]`. Canonical credentials are
  byte-identical afterward; runtime auth.json does not exist. Scratch evidence:
  `/tmp/cs-protocol-CK5FTj` (synthetic only).
- `node scripts/verify-live-protocol.mjs --ui-smoke`: exit 0. Native terminal
  connects to that private Unix service, renders the requested temporary working
  directory, and exits through Ctrl-C. No additional model request was sent.
  Scratch: `/tmp/cs-protocol-REpfUj`. Temporary-home PATH helper warning and one
  MCP startup warning were visible; MCP integration is not part of this test.
- `codex-switch --version`: exit 0, `codex-switch 0.2.0`.
- Real quota probes at 2026-09-15 13:14 UTC marked all three registered accounts
  limited. `codex-switch run --auto --min-remaining 1 -- --version` correctly
  refused with exit 1; its service shut down and `status` reported stopped.
  No real model prompt was sent and no browser login was performed.

Limits: the successful account-switch proof uses real Codex but synthetic quota
and localhost model responses, not two production ChatGPT model generations.
Production in-flight streaming/retries, account policy differences, revocation,
and long-lived token refresh still need owner acceptance when quota is available.
An already-running ordinary Codex process cannot be adopted by this controller.
No claim of uninterrupted completion is made: quota observations lag and an
already-sent request can still fail. External-token auth is experimental.

Independent review found no reproduced blocker; the same-email workspace
confirmation gap was guarded by excluding ambiguous entries. Remaining review
risks: a hypothetical server refresh callback awaited during login could queue
behind activation and time out (not observed); normal UI exit while a quota probe
is pending can wait for probe timeouts before releasing leases. Production
seamless-switch acceptance is explicitly deferred by the owner due to quota.

The V1 record below is historical; its account names and startup-only `--auto`
semantics do not describe the current account pool or V2 behavior.

# V1 verification — 2026-09-15

Environment: Linux, Node v25.8.2, codex-cli 0.154.0.

## Completed

- `npm test`: exit 0; 13 tests passed, 0 failed. All credentials are synthetic,
  all test pools are in temporary directories. Tests cover name/path validation,
  credential permissions and duplicate identities, all quota buckets/windows,
  stale/unknown/future data, native argv/environment binding, auth/backend/profile
  override refusal, RPC errors/timeouts/malformed JSON shapes, staged login and
  wrong-identity preservation, duplicate-login cleanup, config isolation and locks.
- `node --check src/core.mjs`, `node --check src/main.mjs`: exit 0.
- Independent source review completed; no remaining blocker in reviewed scope.
- Installed `~/.local/bin/codex-switch` symlink; command lookup and version work
  from `/tmp`, outside the development directory and research repository.
- Imported the existing ChatGPT login as `current`, referencing its existing
  Codex home. No credential copy or login/logout was performed for this import.
- `codex-switch usage current`: exit 0; real `account/read` and
  `account/rateLimits/read` succeeded with plan and two quota windows.
- `codex-switch doctor`: exit 0; local identity and installed CLI verified.
- `codex-switch use current`: exit 0; default selection persisted.
- `codex-switch run --account current -- --version`: exit 0.
- `codex-switch run --auto -- --version`: exit 0; live quota selection and native
  launch passed. Repeated after the selected-account locked recheck was added.
- Interactive `run --account current -- --no-alt-screen` in the existing trusted
  research repository displayed the original Codex UI/model and working directory.
  Ctrl-C shut it down with exit 0 and released the account lock. No model prompt
  was submitted. The `/tmp` UI startup reached Codex's trust prompt and was exited.
- While the interactive account was locked, `run --auto -- --version` refused
  launch (exit 1). After exit, automatic selection succeeded again.
- Research repository `git status --short` remained empty; implementation lives
  in its own local repository under `~/.codex/tools/codex-switch`.

## Remaining user acceptance

The owner must complete the browser/device-code flow for a second real account:

```sh
codex-switch login second --device-auth
codex-switch usage --all
codex-switch use second
codex-switch run
```

Real second-account authentication, real token-expiry/revocation, managed-account
policy differences, and cross-account model generation were not exercised.
Offline tests cover the corresponding local control flow, not external service
behavior. In-flight account switching is outside V1. See README for separate
history/config behavior, conservative quota selection, and signal/lock limits.
