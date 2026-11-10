# Explicit nonproduction Laya authorization

Status: implemented for staging acceptance; production and model qualification are not claimed.

Ben requested actual command fallthrough and native eight-hour grant acceptance,
not a shadow-only service deployment. The previous local-provider gate ignored
the existing fallthrough opt-in altogether. Local assessment now authorizes only
when the trusted environment is staging/dev/dev1/dev2/dev3 AND both assessment
and fallthrough are explicitly enabled. Otherwise it remains evaluation-only.
Production/unknown environments cannot enable local authorization with these flags.

Keep the existing resolver unchanged: structural evidence must be sufficient,
confidence cutoffs must be met, known effects and explicit workflow restrictions
remain authoritative. Unknown, ambiguous, failed, timed-out or malformed model
results require native human review. Selecting a provider alone grants nothing.
Validated command documentation stays loopback-only in both local modes; enabling
authorization must not silently remove that context or send it to hosted models.

The pinned checkpoint's existing smoke read score of 0.3688 is NOT qualified
authorization evidence. Do not lower thresholds to make that control pass or
claim fixture probabilities are live Laya decisions. Staging is the experiment;
production promotion needs separate qualification and authority.

Rollback: disable the staging fallthrough flag using the supported release
process; new uncertainty falls back to native review. Existing human approval
memory remains separately policy/dependency/owner-bound and explicitly revocable.
Changing a semantic flag is not approval of a workflow review or host permission.
