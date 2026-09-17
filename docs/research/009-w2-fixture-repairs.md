# W2 Windows Fixture Repair Receipt

## Review findings repaired

The W2 frontier review found two defects in the initial fixture cut.

1. The App Server transport passed npm's `codex.cmd` launcher through
   `cmd.exe`, allowing a second argument parse to corrupt quoted provider
   configuration. `windows-command-resolution.mjs` now owns the established
   npm-shim parsing contract. Both supervisor and App Server transport resolve
   recognized shims to Node plus the JavaScript entrypoint, preserving argv;
   ordinary `.cmd` and `.bat` launchers still use the Windows shell.
2. The ownership-race worker waited for a release marker, but a failed
   assertion could remove its temporary directory before writing that marker.
   Cleanup now writes release and waits for the managed supervisor before
   deleting the fixture tree.
3. The transient App Server transport resolved npm's `codex.cmd` shim for the
   TUI, then passed only `node.exe` into its owned App Server runtime. That
   dropped the JavaScript entrypoint and made Node receive `app-server` as if
   it were a script path. The runtime now accepts the complete resolved launch
   descriptor, while its raw-command callers still resolve their own launch.
   A portable combined-path fixture drives a fake Windows shim through the
   transport and proves that the App Server reaches readiness through its
   entrypoint.

The Windows canary explicitly selects `codex.cmd` before passing `CODEX_BIN`
to the native App Server fixture. This avoids PowerShell selecting npm's
`.ps1` shim.

## Validation boundary

`task test:windows-w2-fixtures` covers portable ownership races, App Server
transport units, canary syntax, workflow YAML parsing, and `git diff --check`.
`task test:codex-native-approvals` covers the approval and ownership suite.
The hosted `windows-2022` run remains the only evidence that executes these
paths on Windows; it is pending the authorized push or dispatch. This receipt
does not claim authenticated vendor turns, interactive decisions, WSL, or
desktop-app integration.
