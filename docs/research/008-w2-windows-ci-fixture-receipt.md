# W2 Windows Credential-Free Fixture Receipt

## Purpose

This receipt defines the W2 native-Windows CI evidence cut for the Statewright
control plane. It is intentionally credential-free and runs on the
`windows-2022` GitHub Actions runner for pull requests as well as trusted-main
events.

## Added checks (hosted receipt pending)

`windows-managed-app-server-canary.mjs` resolves the npm-installed `codex.cmd`
launcher, creates a private temporary `CODEX_HOME`, removes API-key and auth
token environment variables, and starts the real Codex App Server through the
Statewright-owned runtime. On the pending hosted run it must verify JSON-RPC
initialization, server-notification delivery, a native approval elicitation
form, journal retention when the form is dismissed, and that the parked turn
cannot begin inference.

`managed-ownership-races.test.mjs` is portable Node coverage used locally and
on the Windows runner. It verifies locally that concurrent owners have one winner,
that released and stale leases can hand over, and that a second resumed
supervisor is rejected before it can start another child process. The Windows
branch uses a `.cmd` launcher; the POSIX branch uses an executable Node file.

The runtime now explicitly invokes `cmd.exe` only for Windows `.cmd` and
`.bat` App Server launchers. This closes the mismatch between the managed
supervisor and `startCodexAppServerRuntime` when GitHub resolves `codex` to
`codex.cmd`.

## Evidence boundary

Local evidence for this cut is repeatable through `task test:windows-w2-fixtures`
and `task test:codex-native-approvals`. Together they execute the portable
ownership race and App Server launcher-options tests, syntax-check the
Windows-only canary, parse the workflow YAML, and require a clean
`git diff --check`. GitHub Actions remains the authoritative Windows runtime;
a green hosted
`windows-2022` run of the two added steps is pending the human-owned push or
dispatch gate.

This receipt does **not** claim an authenticated vendor turn, a human approval
decision, WSL behavior, a stock Codex or ChatGPT desktop app integration, a
Claude desktop integration, or a full interactive native-Windows acceptance
session. Those remain separate W1, W2, and X0/X1 gates.
