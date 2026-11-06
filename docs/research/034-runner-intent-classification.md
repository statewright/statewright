# Runner intent and tool-specific metadata flags

2026-11-06. Source repair; not installed or staging acceptance.

## Defects and bounded repair

Python's standard unittest module runner had no adapter to the existing
`BoundedLocalExecution` operation. Consequently even literal discovery arguments
remained unknown when the workflow already granted test execution. Recognize the
module/discovery grammar, literal repository-relative selectors and documented
runner options. This grants no Read authority and is not a sandbox: tests and
import/configuration hooks execute repository code with transitive effects.

Keep other modules, direct scripts, inline code, path escapes, unknown options,
path-qualified executable lookalikes and expansions unresolved. Reject explicit
`PYTHON*` environment assignments, including transparent `env` forms: interpreter
controls such as `PYTHONINSPECT` can add interactive execution outside the runner
grammar. This concerns explicitly parsed assignments, not a claim to validate
the complete inherited process environment. Existing executable resolution and
execution-capability assumptions remain unchanged.

The shared version grammar also treated `pytest -v` as pure output, although it
runs tests verbosely. Version options now belong to each existing tool contract:
Node/npm/pnpm accept `--version`/`-v`; Cargo/rustc accept `--version`/`-V`.
Pytest metadata probes no longer receive pure-output proof because plugin and
initial conftest loading still occurs. No generic flag spelling supplies effect
or permission evidence.

Primary references: [unittest discovery](https://docs.python.org/3/library/unittest.html#test-discovery),
[pytest verbosity](https://docs.pytest.org/en/stable/how-to/output.html),
[pytest configuration initialization](https://docs.pytest.org/en/stable/_modules/_pytest/config.html),
[Cargo version](https://doc.rust-lang.org/cargo/commands/cargo-version.html),
[Node version](https://nodejs.org/api/cli.html#-v---version).

## Security boundary

No capability, threshold, model, workflow or approval protocol changed. Only
workflows with the existing explicit execution capability admit the supported
runner. Read, Write alone, missing capabilities and explicit Bash/execution
denials still deny. Additional compound effects are independently checked.
Unknown-command human effect review remains a separate unresolved contract;
this adapter does not turn general human consent into missing effect evidence.

## Executed evidence

- Red: new version test failed because `pytest -v` returned `SafeOutput`.
- Red: new unittest test failed because discovery returned `Passthrough`.
- Initial repaired classifier group: 98 passed.
- Initial gateway matrix: one test passed, 60 decisions.
- Independent source review found explicit Python interpreter-control variables
  unguarded. Added the rejection and regression cases; reviewer confirmed closure.
- Final default gateway library suite: **449 passed, 0 failed, 7 ignored**.
  This includes the expanded 12-command by 6-policy matrix (72 decisions), parser,
  production resolver and unrelated gateway regressions. Existing compiler
  warnings were not suppressed. An earlier full-run result was unavailable after
  output loss; it is not counted as passing. No owned Cargo process remained
  before the final post-review suite ran.
- Separate ignored private-ledger diagnostic: **95 decisions**, exit 0; no ledger
  command executed, no model invoked, no live workflow changed. The originally
  recorded unittest discovery now admits in validation and implementation
  policies declaring execution; Read and explicit denials still deny. The
  synthetic policy without declared capabilities does not acquire execution.
- Pre/post source and ledger hashes matched for that audit. Its receipt SHA256 is
  `1603eefa8a35054b700b22964af138fd29e3a1b9cf12a0a57e7ef62223511203`.
  Private command text and local paths are not published here.

## Remaining delivery gates

Direct Python scripts and unknown effects are not solved by this adapter.
No denial-ledger entry was cleared. Actual original-invocation acceptance and
native approval behavior must be distinguished from these static gateway
decisions. The separate installed review fixture remains pending account
entitlement; source notifier wording repair is not installed proof. Desktop
acceptance remains unverified. No partial install, cache edit, or staging
deployment occurred in this milestone.
