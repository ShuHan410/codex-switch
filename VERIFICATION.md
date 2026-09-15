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
