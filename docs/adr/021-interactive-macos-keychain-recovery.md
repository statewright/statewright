# ADR 021: Interactive macOS Keychain recovery for managed TUI launchers

Status: Accepted for a local 0.3.4 candidate; live SSH acceptance pending

## Context

The 0.3.4 managed Codex launcher resolves its gateway-scoped credential before
starting a resumed TUI. On aerith.local the same staging credential is readable
from the graphical login, while `scodex resume` over SSH exits with “OS
credential store could not read this gateway credential.” The helper currently
maps every keyring error other than `NoEntry` to that message, so the exact
macOS status is not established by the existing output.

Apple documents that SSH login does not unlock a Mac login keychain and that
`security unlock-keychain` can unlock it interactively without placing its
password in a command argument: <https://developer.apple.com/forums/thread/712005>
(accessed 2026-10-11). This is a plausible cause of the observed split, not
proof that the individual keychain error was a lock rather than item access
control or a different SSH security context.

## Decision

- Only the interactive managed TUI launcher offers recovery, and only on macOS
  after a typed unavailable-store read. Missing credentials continue through
  browser approval; explicit process credentials and successful reads do not
  enter this path. Desktop and noninteractive processes do not prompt.
- The user must confirm that unlocking the macOS default keychain can leave it
  available until macOS locks it again. Statewright then invokes the fixed
  `/usr/bin/security unlock-keychain` executable with inherited terminal IO,
  no shell and no password argument. Apple owns the hidden password prompt;
  Statewright never receives or stores that password.
- A successful unlock causes exactly one retry of the original gateway-scoped
  lookup. Failure, cancellation, or another unavailable read stops launch with
  a bounded message. A genuinely missing credential on retry retains its
  missing status and browser-approval path.
- Linux Secret Service and Windows Credential Manager are not treated as Mac
  keychains. Their unavailable-store errors remain fail-closed pending
  platform-specific, independently validated recovery paths.

## Security and privacy

No credential moves to a file, command argument, shell history, diagnostic,
or alternate gateway. Unlocking does not alter keychain ACLs or auto-lock
policy. The prompt is never started without an interactive stdin and stderr.
The existing gateway identity and helper remain authoritative after unlock.

## Consequences and validation

Fixture tests cover fixed executable/argv, one retry, cancellation, unlock
failure, missing credentials, noninteractive macOS, and Linux/Windows no-op
behavior. The actual readline confirmation and a one-shot Codex TTY are also
covered. Generated Codex and Claude runtime copies match the source; the full
`task test:plugin-release` gate exited 0 on the reviewed candidate
`0.3.4+codex.20261011140803`. Live SSH acceptance must use the normal
`scodex resume` launcher and remains separate from those tests; an untrusted
SSH host key must not be bypassed to manufacture that evidence.

The supported managed-client installer placed this candidate at
`~/.statewright/runtime/codex/0.3.4+codex.20261011140803` and switched only
the local Codex shim. Installed launcher and credential-store bytes match the
tested source, and `scodex --version` reaches Codex CLI 0.160.0. That version
smoke does not exercise the keychain lookup; SSH resume acceptance is pending.

## Rollback

Revert this local change and reinstall the previous managed-client package.
The stored gateway credential and keychain settings are unchanged. A user can
still explicitly run Apple's interactive `security unlock-keychain` command
before retrying a TUI launch.

## Rejected alternatives

- Copy the API key to an environment variable or plaintext file: broadens
  exposure and loses the OS store's access boundary.
- Pass the keychain password using `security -p`: exposes it in process
  arguments and potentially history.
- Automatically unlock without a user decision: changes the user's keychain
  state as a side effect of an ordinary launcher command.
- Retry all store failures or launch unmanaged after an unavailable read:
  hides access-control defects and may misrepresent Statewright enforcement.
