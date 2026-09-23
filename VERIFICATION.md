# Verification history

This file records dated/versioned evidence, newest first. Commands, test counts,
account labels and temporary paths describe those runs, not current machine
state; temporary artifacts may no longer exist. Older acceptance checklists are
historical, not instructions to resume operations on real accounts.

For current installation, behavior and limitations, read [README.md](README.md).
For change scope, safety and verification rules, read [AGENTS.md](AGENTS.md).
Do not treat synthetic/local protocol checks as production seamless-switch proof.
Documentation-only edits need not create another runtime-verification entry.

# Reverse-refresh deadlock regression — 2026-09-23

The user's next trace showed two server token-refresh requests during
`account/read`; both handlers started but failed only after the read timed out.
The controller queued these callbacks behind the activation that was waiting
for their replies. A bounded regression reproduced this dependency cycle in
both `account/login/start` and `account/read` on the previous implementation.

Refresh callbacks now run in a separate serialized queue and can use a locked,
validated pending candidate before login confirmation. Activation drains old
refresh work and its controller replies before submitting a different account.
Active-account confirmation remains mandatory; failed activation retains leases
and pauses switching. Shutdown waits for refresh work and rejects late tokens.
The protocol fixture injects a synthetic refresh callback instead of launching
OAuth refresh with its fake tokens.

- Before the fix, `node --test test/live.test.mjs`: exit 1; 4 of 13 tests failed,
  including both callback deadlocks and a late refresh result after close.
- A subsequent ordering regression caught a new-login message preceding the old
  refresh reply. Tracking controller replies fixed that ordering; a local Unix
  WebSocket fixture independently checks the received message order.
- Final `node --test test/live.test.mjs`: exit 0, 16 passed, 0 failed.
- `npm test`: exit 0, 66 passed, 0 failed.
- `git diff --check`: exit 0.

All automated tests use synthetic accounts and local services. A user-side rerun
of `node scripts/verify-live-protocol.mjs --trace` is pending; the agent-side
Codex socket-startup restriction was not bypassed. Production token refresh and
streaming remain unverified. A cross-family Claude Opus review identified the
reply-ordering issue above; a fresh GPT-6 Sol review of the corrected code and
WebSocket regression returned PASS with no further blocking findings.

# Account-read timeout follow-up — 2026-09-23

The user's trace completed `initialize` (155 ms) and `account/login/start`
(44 ms), then timed out on `account/read` (20004 ms). No thread or model turn
had started, so this is not evidence of a GPT-6 model-request failure.

Extended `--trace` to show whitelisted login/account notifications, reverse
token-refresh requests and handler progress, and numeric RPC response IDs
(with string IDs distinguished). No request/response payloads are logged.
The possible refresh/activation queue cycle noted in the V2 record remains
unconfirmed for this run; no speculative auth, lock, or timeout change was made.

`node --check scripts/verify-live-protocol.mjs`, `npm test` (58 passed, 0 failed),
and `git diff --check` exited 0. The timeout remains unresolved pending a
user-side trace with the additional diagnostics; the real-CLI protocol check
has not passed in this follow-up.

# Protocol timeout diagnostics — 2026-09-23

The user reran the GPT-6 fixture outside the agent environment and reported
`Codex service request timed out.` This differs from the startup failure below,
but the original generic message does not identify which RPC timed out.

The script now includes the RPC method in request failures. Optional `--trace`
output records method start/completion/failure and elapsed time, local model
request counts, socket readiness, and child exit status. It never logs RPC
parameters/results, authorization headers, or raw server stderr. Timeout values,
transport, model selection, and account-switching logic are unchanged.

- `node --check scripts/verify-live-protocol.mjs`: exit 0.
- `npm test`: exit 0, 58 passed, 0 failed.
- `git diff --check`: exit 0.

These checks do not reproduce or resolve the user's real-CLI timeout. A user-side
rerun of `node scripts/verify-live-protocol.mjs --trace` is needed to identify
the affected request. The agent-side startup restriction remains unresolved;
no permission or authentication workaround was attempted.

# GPT-6 protocol fixture model — 2026-09-23

Updated the local protocol fixture's `thread/start` model from `gpt-5.6-terra`
to `gpt-6-sol`. Account-switching implementation and user defaults are unchanged.

- `npm test`: exit 0, 58 passed, 0 failed, using the existing installed dependencies.
- Installed CLI: `codex-cli 0.156.1`.
- `node scripts/verify-live-protocol.mjs`: exit 1 before any model turn;
  `Synthetic server startup failed.` A focused startup reproduction captured
  `app-server socket directory must be a user-owned directory with mode 0700`.
  Both the synthetic scratch directory and its `live` home were owned by the
  current user with mode `0700`; the remaining cause was not established.
  No permission, credential path, or transport workaround was attempted.
- Dependency installation in an isolated worktree was stopped after npm reported
  a read-only default cache. Runtime checks above used the main checkout's
  existing installation; dependencies and the lockfile were not changed.

Only temporary synthetic accounts and a localhost fixture were used. The updated
model pin has not passed the real-CLI protocol check in this environment;
production GPT-6 requests, streaming, token refresh, and seamless switching
remain unverified. Re-run the protocol check after the startup restriction is
resolved; older successful protocol records below do not validate this change.

# Running-session account boundary — 2026-09-19

Diagnosed with installed `codex-cli 0.155.1`, synthetic account tokens and a
localhost model fixture. Replacing `auth.json` while the Codex App Server was
running did not change its in-memory account: two consecutive turns used
`alpha`. Sending the supported `account/login/start` RPC through `run --auto`
then changed the next turn in the same thread to `beta`. Observed request
accounts were therefore `alpha`, `alpha`, `beta`.

`auto` now states at startup and after a native-login switch that already-running
Codex sessions keep their account, and points long-running work to
`codex-switch run --auto`. Help and README distinguish file switching from
same-session switching and document how to choose a raised test threshold.

- `npm test`: exit 0, 58 passed, 0 failed.
- `node scripts/verify-live-protocol.mjs`: exit 0; `sameThread: true`,
  `diskReplacementIgnoredByRunningService: true`, `requestAccounts:
  ["alpha","alpha","beta"]`, `automaticQuotaTrigger: true`.

No real credentials, quota service or production model request was used. A
standalone Codex session that was not launched against the controlled private
App Server still cannot be attached or switched after startup. Production
streaming and long-duration token refresh remain unverified.

# Native monitor terminal activity — 2026-09-16

`auto` now reports startup and shutdown, refreshes one heartbeat line in an
interactive terminal after each quota check, and preserves switch/warning events
as separate lines. Redirected output omits periodic heartbeats and deduplicates
unchanged warnings; `--quiet` retains the former silent behavior. `status --auto`
was removed; plain `status` remains for the experimental `run --auto` session.

`npm test`: exit 0, 58 passed, 0 failed. Coverage includes interactive heartbeat
refreshes, redirected-output suppression and warning deduplication, `--once`
summaries, `--quiet`, removed `status --auto`, switching, and signal/lock cleanup.
No real credentials, quota service, native account pool, or production Codex
session was used. Interactive rendering was verified through a synthetic output
sink rather than a real terminal.

# Bounded parallel usage queries — 2026-09-16

`usage --all` now probes at most two independent account homes concurrently,
without a CLI concurrency option or cache reuse. Results retain sorted pool
order and single-account usage follows the same path with one worker.

The regression fixture delays every RPC response and records child-service
start/end events: four accounts reach peak concurrency 2, all four services
finish, and JSON order remains `alpha`, `beta`, `delta`, `gamma`. No real
credentials, quota API, native login or account pool was used.
`npm test`: exit 0, 53 passed, 0 failed. `git diff --check`: exit 0.

# Local time and health colors — 2026-09-16

Checked/reset text uses host-local time (or TZ), seconds and explicit UTC offset.
Stored/JSON timestamps remain unchanged. Interactive terminals color account
badges and percentages; non-TTY, NO_COLOR and TERM=dumb remain plain text.
Green/low/empty use minimum quota headroom; unknown or >=60s-old checks are
muted. The display threshold does not change automatic-switch settings.

`npm test`: exit 0, 50 passed, 0 failed. Coverage includes DST, fractional offsets,
5%/0% boundaries, stale/unknown states, CLI local-time output, unchanged JSON,
and existing switching regressions. No real credentials, quota calls or native
login changes were used. No production seamless-switch test was performed.

# Terminal presentation refresh — 2026-09-16

Presentation-only: grouped help, aligned account/plan/state rows, separate
identity/check/reset details, explicit native-versus-run-default labels, empty
pool guidance, and multiline monitor status. Plain text without ANSI or new
dependencies. Command routing, JSON schema, exit codes, and silent auto behavior
are unchanged. README includes an illustrative output preview.

`npm test`: exit 0, 47 passed, 0 failed; includes text sanitization, clean JSON,
empty-pool guidance and existing native-switch/auto regression checks.
`git diff --check`: exit 0. Independent source/help review found no blockers.
No real login, quota call, account-pool mutation or live session test performed.

# Remaining quota and pool editing (0.4.0) — 2026-09-16

Text usage displays `100 - usedPercent` as `% left`; JSON raw API fields
remain compatible. `rename OLD NEW` changes metadata and the selected label,
without moving homes. `remove NAME` unregisters the record into private
`removed/NAME-UUID.json`, clears a matching default, and retains credentials,
history and native login. Reusing a name allocates a fresh home when needed.

Account/settings locks protect edits; post-lock identity/home validation rejects
stale registrations. Probe failures cannot recreate removed records. Tests use
synthetic credentials and temporary pools, including remaining display, rename,
remove, native marker after removal, busy/collision rejection, retained-home
name reuse, and stale-query resurrection prevention.

`npm test`: exit 0, 46 passed, 0 failed. No real account was renamed, removed,
logged out or switched during this update; no live quota API call was needed.
Independent source review and a separate test run passed (46/46, exit 0);
`git diff --check` passed (exit 0).

# Native permissions and active marker (0.3.2) — 2026-09-15

Observed native home: owned by current uid, mode 775. The old 0022 guard rejected
this valid user-owned installation. `use`/`auto` now open the directory with
O_DIRECTORY/O_NOFOLLOW, validate ownership, and clear only group/other write
bits via fchmod before credential operations (775 becomes 755). Symlinks and
foreign ownership are still rejected; list/usage do not change native permissions.

`list` and `usage` detect the native file identity after quota probes. The star
means a matching registered identity, not `pool.selected()`. Unregistered,
missing and unreadable credentials produce no star and explicit native state.
JSON keeps `selected` as the run default and adds `active` and `nativeState`.
Both commands accept `--codex-home`; neither updates the stored selection.

Tests cover use on mode775, symlink refusal without mutation, list/usage following
manual native changes, unregistered/logout/invalid credentials, explicit home,
JSON selection versus active identity, and no permission mutation during display.
`npm test`: exit 0, 41 passed, 0 failed. `git diff --check`: exit 0.
Independent source review found no blockers. Real read-only `codex-switch list`
showed the native login matching `second`; no real login was changed in testing.

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
