# ADR 015: MCP intent and explicit authorization are separate

## Status

Implemented locally on 2026-09-27; deployment is pending. Builds on ADR 014.
The user explicitly deactivated Statewright during repair. Do not reactivate
it automatically as part of installation or validation.

## Failure

The standalone legacy Codex hook rejected an exactly allowed MCP operation
as opaque because it checked built-in capability families but never checked
the provider identity against the phase allowlist. This affected both a
read (`list_task_lists`) and an explicitly approved task update.

Separately, adapter pre-tool classification discarded registered MCP metadata.
Name inference included server namespaces, and the System One request lacked
MCP invocation shape. The earlier shared fallthrough implementation remained
on an unintegrated branch; it was not proof of installed behavior.

## Decision

- Preserve exact provider identities for legacy authorization and explicit
  denials. Do not remove punctuation, collapse servers, or add provider-specific
  exceptions. Built-in shell/edit checks remain ahead of the exact-name rule.
- Use dispatch-bound registered metadata for both gateway entry points.
  Conflicting descriptors fail closed, distinctly from absent metadata.
  Caller-supplied arguments cannot supply trusted annotations.
- Infer operation intent separately from the MCP server namespace, retaining
  the entire method name, including embedded double underscores.
- Send only a bounded MCP operation shape through the existing System One
  provider: operation intent, fixed selector labels, selector-schema presence,
  metadata availability, idempotency, and opaque-payload evidence. Never send
  raw descriptions, schemas, selected values, task titles, queries, or tokens.
- Negative annotations, known mutation selectors, and destructive method names
  cannot be erased by optimistic read-only inference. Execution/query payloads
  omitted from the classifier are not sufficient evidence to grant access.
- A closed-world annotation is not evidence of local execution. See the
  [MCP annotation contract](https://modelcontextprotocol.io/specification/2025-06-18/schema#toolannotations).
  Unknown MCP mutations require the existing probability/uncertainty pathway;
  they do not silently become local writes.
- Exploratory phases check invocation effects as well as metadata, even when
  blacklist mode is absent. Explicit denials and pending approvals still apply.

## Scope and limitations

No new inference provider, raw-payload egress, default-allow fallback, workflow
mutation, or production deployment is introduced. Generic selectors are
deliberately bounded; unrecognized forms stay uncertain. Registered tools are
trusted configured upstreams, not arbitrary caller-provided descriptors.
Tool names and hints remain imperfect evidence; this is not a proof of a
tool implementation's behavior or calibrated model accuracy.

External/account writes still require the approved execution path. Classifying
an operation does not create consent. Legacy exact phase authorization is
honored without pretending that an authorized write is read-only.

## Rollout and rollback

Integrate the prerequisite semantic-risk-fallthrough commits and this repair
as one reviewed runtime change; coordinate gateway deployment and plugin
reinstallation from the resulting SHA. Validate actual supported MCP identities
in an isolated canary, including denials and classifier failure. Do not claim
an installed fix from source tests or refresh the plugin alone against an old
gateway. Keep the current workflow deactivated until that validation succeeds.

Rollback this repair with a normal revert; keep semantic authorization disabled
or the workflow deactivated if the provider/runtime contract is unavailable.
Do not restore a growing shell grep exception list.
