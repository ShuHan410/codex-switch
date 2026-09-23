# codex-switch

[繁體中文](README.md) | [English](README.en.md)

Manage multiple Codex ChatGPT subscription accounts from the terminal: check remaining usage, switch the native login, and automatically move a managed Codex session to an available account based on remaining usage.

> This is an unofficial tool and is not affiliated with OpenAI. It does not provide accounts, share subscriptions, or increase or reset usage limits. Only manage accounts you are authorized to use, and follow all applicable service and organization policies.

The current version is v0.4.0. It supports Linux, Node.js 22+, Codex CLI, and file-based ChatGPT `auth.json` authentication. macOS, Windows, API keys, keyrings, the VS Code extension, and the desktop app are not yet supported.

## Features

- Add accounts through the official login flow or import the current Codex login.
- Query the remaining usage for each account in plain text or JSON.
- Manually switch the native `~/.codex/auth.json` login.
- Monitor and switch the native login file from another terminal for Codex processes started afterward.
- Start a managed session with the experimental `run --auto` mode so later turns can switch accounts automatically.
- Start Codex with an isolated home for a selected account, separating credentials and conversations.
- Rename accounts and remove them recoverably.

## Installation

First, confirm that Node.js 22+, npm, Git, and Codex CLI are installed:

```sh
node --version
npm --version
git --version
codex --version
```

Install from [GitHub](https://github.com/ShuHan410/codex-switch) without sudo:

```sh
mkdir -p "$HOME/.local/share" "$HOME/.local/bin"
git clone https://github.com/ShuHan410/codex-switch.git "$HOME/.local/share/codex-switch"
cd "$HOME/.local/share/codex-switch"
npm ci --ignore-scripts
ln -s "$PWD/bin/codex-switch.mjs" "$HOME/.local/bin/codex-switch"
codex-switch --version
```

If the command cannot be found, add the following line to `~/.bashrc` (or `~/.zshrc` for Zsh), then open a new terminal:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

If `~/.local/bin/codex-switch` already exists, inspect its source with `ls -l` before replacing anything. The tool is currently installed from GitHub source and is not published as an npm package.

Stop `auto` and `run` before updating, then run:

```sh
cd "$HOME/.local/share/codex-switch"
git pull --ff-only
npm ci --ignore-scripts
codex-switch --version
```

## Quick start

Save the account currently signed in to native Codex into the account pool:

```sh
codex-switch import personal
codex-switch usage personal
```

Or add another account through the official login flow:

```sh
codex-switch login work
# The device-code flow is also available
codex-switch login work --device-auth
```

List and switch accounts:

```sh
codex-switch list
codex-switch usage --all
codex-switch use work
codex
```

`personal` and `work` are user-defined names. A name must be 1–48 characters long, may contain only ASCII letters, digits, `_`, and `-`, and must begin with a letter or digit.

## Commands

| Command | Purpose |
| --- | --- |
| `import NAME [--source-home PATH]` | Copy an existing login into an independently managed home |
| `login NAME [--device-auth]` | Add an account or reauthorize an account with the same name |
| `list [--json]` | List accounts and the current native login without querying fresh usage |
| `usage [NAME \| --all] [--json]` | Query fresh usage for one or all accounts |
| `use NAME` | Switch the native login and update the tool's default account |
| `auto` | Automatically switch the login file; already-running Codex sessions do not switch |
| `run [--account NAME] [-- ARGS...]` | Start Codex with an isolated home |
| `run --auto [-- ARGS...]` | Start Codex with account switching in the same session (experimental) |
| `rename OLD NEW` | Rename an account in the pool |
| `remove NAME` | Remove an account from the pool while retaining recoverable data |
| `doctor` | Check local configuration without validating server authorization |

Run `codex-switch --help` for all options.

### Login and account pool

`import` copies the login from the current `CODEX_HOME` (default: `~/.codex`) without opening a browser or modifying the source. `login` starts a new official login flow. Reauthorizing an existing name updates its credentials only when the underlying account and workspace identity are the same. Both commands store the result in an isolated Codex home.

The same underlying identity cannot be added under different names. An `import` is a login snapshot, not a new OAuth authorization. If the source and pooled copy both refresh the same token set, either copy may still become invalid. When authorization expires, sign in again with `codex-switch login NAME`.

`rename` does not move login data or conversations. `remove` only removes an account from the pool; it does not log out, revoke access, or erase credentials. The command prints the location of the recoverable record. An account locked by this tool cannot be renamed or removed.

### Usage and manual switching

`usage` queries the local `codex app-server` without starting a model turn. When querying all accounts, it processes at most two accounts concurrently, obtains fresh data for every account, does not reuse the usage cache, and does not offer an option to change concurrency. `list` reads cached status only, but always compares it again with the native login file.

`use NAME` atomically replaces the native login file and saves the required backup. It does not modify native settings or history. It does not query usage and cannot guarantee that an already-running Codex session will adopt the new login. To select a native home, pass `--codex-home PATH` to `list`, `usage`, `use`, or `auto`.

Text timestamps use the host's timezone; set `TZ=Asia/Taipei` temporarily to override it. Interactive terminals use color to distinguish states; set `NO_COLOR=1` to disable color. `--json` output never contains color codes.

### Starting Codex with an isolated home

```sh
codex-switch run                         # Use the tool's default account
codex-switch run --account work
codex-switch run --account work -- --no-alt-screen
codex-switch run -- resume --last
```

Arguments after `--` are passed to Codex. Each account has separate conversations, databases, memories, settings, and credentials; `resume --last` sees only conversations from that home. `AGENTS.md`, skills, rules, agents, and prompts are linked to the source home used when the account was created. Settings tied to an account or backend are not copied. MCP and plugin logins must be configured separately. `run` rejects login, profile, and backend override arguments.

## Automatically switching the native login: `auto`

`auto` only monitors and replaces the native login file. It is intended for workflows that can restart Codex after a switch. It cannot take over an already-running Codex session and is not suitable for long-running work that must remain uninterrupted.

```sh
# Terminal A
codex

# Terminal B
codex-switch auto
```

Even after terminal B reports a switch, the existing Codex process in terminal A continues using the old account loaded into memory at startup. Exit and reopen that session to load the new login. To switch accounts for later turns in the same session, start Codex with `codex-switch run --auto` as described in the next section.

`auto` checks immediately, then waits 30 seconds after each completed cycle by default. It:

1. Identifies the current account by matching the account and workspace identity in the native `auth.json`.
2. Queries every usage window for the current account.
3. Queries the other accounts again if any window is exhausted or falls below 5% remaining.
4. Selects the account whose lowest remaining window is highest and at least 5%, then safely replaces the native login file.

The current native account must already be in the pool through `login` or `import`. The tool does not force a switch when usage is unknown, a query fails, the login changes during the query, or no suitable replacement exists.

```sh
codex-switch auto --min-remaining 5 --poll-interval 30
codex-switch auto --codex-home "$HOME/.codex"
codex-switch auto --once          # Run one cycle; switch if necessary
codex-switch auto --quiet         # Stay quiet while monitoring and switching normally
```

An account exactly at the threshold does not trigger a switch; the remaining amount must fall below it. On startup, the tool prints its monitoring settings. In an interactive terminal, it updates the current account, remaining usage, and next check time on one line, while switches and warnings receive separate lines. Redirected output omits periodic heartbeats to avoid large logs, and `--quiet` disables all normal output. Stopping with Ctrl-C does not undo completed switches. Only one monitor may use the same account pool and native home at a time.

`auto` only updates the login file. It does not start, take over, restart, or replay an existing session, and it does not verify that an existing session adopted the new account. Stop `auto` before running native `codex login/logout` or `use` manually; ordinary Codex processes do not honor this tool's account locks.

## Switching within the same session (experimental): `run --auto`

```sh
codex-switch run --auto
codex-switch run --auto --min-remaining 10 --poll-interval 30
codex-switch run --auto --min-remaining 20 --poll-interval 5  # Keep a larger buffer for long tasks
codex-switch status
codex-switch run --auto -- resume --last
```

Use this command to start Codex for a long-running task that cannot restart the session when usage is exhausted. The tool starts a dedicated Codex App Server and interactive terminal, then switches accounts through the login RPC within the same service so later requests can attempt to continue on the same thread. The default threshold is 10% with a 30-second interval. The tool does not interrupt or replay a turn that has already been sent. Conversations are stored in `~/.codex/account-pool/live/codex-home/`.

Before a long task, run `codex-switch usage --all` to confirm that candidate accounts exist, then consider raising the threshold and shortening the polling interval. A candidate must itself meet the threshold, so do not raise the threshold above the remaining amount of every account. At startup, `run --auto` selects the eligible account with the most remaining usage. When all accounts have ample usage, merely raising the threshold may not immediately produce a second switch with real accounts. This project uses `node scripts/verify-live-protocol.mjs` with synthetic local usage data to reproducibly verify same-thread switching.

Codex token-refresh requests can be handled while login confirmation is pending. Automatic switching pauses if the new account cannot be confirmed.

This interface remains experimental. It cannot take over a process started by ordinary `codex`; long-running refresh and streaming switches against the production service have not been fully verified; ambiguous accounts with the same email but different workspaces are excluded; and only interactive terminals are supported. When restarting Codex after a switch is acceptable, the simpler `auto` mode remains the more conservative choice.

## Data and security

| Data | Default location |
| --- | --- |
| Program | `~/.local/share/codex-switch/` |
| Command symlink | `~/.local/bin/codex-switch` |
| Account pool | `~/.codex/account-pool/` |
| Account home | `~/.codex/account-pool/accounts/NAME/codex-home*` |
| `auto` backups | `~/.codex/account-pool/auto/backups/` |

The account pool, backups, and retained homes contain login credentials. Their directory and file modes are 700 and 600, but they are not an encrypted vault. Do not upload `~/.codex`, `auth.json`, the account pool, conversations, or diagnostic output. The program repository and account data are separate.

`use` and `auto` accept only a real native home owned by the current user; symlinks and directories owned by another user are rejected. They remove group and other write permissions, for example changing mode 775 to 755. `list` and `usage` do not adjust permissions. Resolve the root cause of permission or authentication errors instead of bypassing these checks.

A forced termination or host failure may leave a `.lock`. The tool never steals a lock automatically. Before handling a lock manually, confirm that the host and PID recorded in `owner.json`, along with any Codex child processes, have stopped. Do not delete account data.

Environment variables:

- `CODEX_HOME`: native Codex home.
- `CODEX_SWITCH_HOME`: account pool location.
- `CODEX_SWITCH_CODEX`: Codex executable, primarily for tests or systems with multiple installations.
- `NO_COLOR`: disable terminal colors.

Exit codes: 0 for success; 1 for a command or operation error; 2 when `usage` or `doctor` has unverified accounts; 3 when an account lock is busy. `run` and interactive login return the Codex exit code.

## Limitations

- No notifications, task replay, automatic continuation, shell interception, or permanent credential erasure.
- Usage is a window percentage returned by the service, not an exact token count, and other devices may consume it.
- Multiple copies of the same refresh token may invalidate one another; sign in again when needed.
- Administrator, workspace, and Codex restrictions remain in effect; this tool does not bypass them.

## Development

See [AGENTS.md](AGENTS.md) for maintenance rules and module responsibilities. Historical verification evidence and items that remain unverified are recorded in [VERIFICATION.md](VERIFICATION.md). For ordinary changes, run at least:

```sh
npm ci --ignore-scripts
npm test
git diff --check
```

For changes to the experimental live protocol, also run `node scripts/verify-live-protocol.mjs`.
This uses synthetic accounts and local routing, configuration and model services;
the real CLI handles login and `account/read`. Success does not verify production services.
On failure, add `--trace` for stages, RPC error codes and allowlisted error phrases;
other server details remain redacted. An empty phrase list means unrecognized text,
not an established cause.

## License

No LICENSE file is currently included. A public GitHub repository may be viewed and forked, but until a license is selected, it does not grant broad rights to use, modify, or distribute the code.
