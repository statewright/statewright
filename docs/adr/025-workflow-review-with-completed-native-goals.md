# Workflow review with completed native goals

Status: source repair in the 0.3.9 candidate; installed acceptance pending.

## Context

A pending workflow review could not present its native decision form when an
older Codex goal remained `complete`. A later ordinary user turn failed at the
same gate. The code treated every nonactive/nonpaused goal as something the
workflow approval had to resume, even though a completed goal is historical
metadata and the workflow has its own authoritative run and approval ticket.

The defect was observed in the real native TUI, with a pending review checkpoint,
the completed-goal footer and the exact installed error branch. A read-only
native goal database check confirmed `complete`. No live goal, approval ticket,
workflow state or owner binding was changed to diagnose or prepare the repair.

## Decision

Preserve the existing pause/resume contract for active and paused native goals.
For a matching completed goal, present and resolve the exact owned workflow
review, then use an ordinary routed turn without a native goal activation.
Clone and recheck the completed descriptor through decision and routing awaits:
status, objective, creation identity and any returned goal/thread identity fields
must still match. A changed, cleared or foreign goal prevents continuation and
retains the checkpoint. Malformed completed descriptors do not qualify.

An explicit native goal activation request while the workflow review is pending
retains refusal for a completed goal. Workflow approval is not authority to
reactivate that goal. Existing blocked, usage-limited, budget-limited and unknown
goal statuses retain their fail-closed behavior; this repair grants them no new
execution authority.

Owner, root thread, run/session, exact ticket, applied destination, activity
epoch, routing lease, idle and positive native acknowledgement checks remain in
place. Review rejection/cancellation/disconnection preserves its established
semantics. No synthetic approval, workflow transition, automatic goal creation,
status rewrite or hook/classifier/security bypass is introduced.

## Evidence and rollout

Red regressions reproduce the ordinary-input and automatic-continuation failure.
Gate and real WebSocket proxy fixtures verify presentation, destination routing,
completed-goal preservation, reconnect, ownership loss and replacement during
routing. Independent review additionally reproduced and then verified refusal
of the explicit goal activation path. These are source/protocol checks, not real
TUI acceptance of the new installed candidate.

Regenerate the Codex runtime copies, refresh the complete source/package release
identity and controller, and run the full plugin gate before delivery. Validate
the actual installed candidate through the supported native host, retaining the
original approval identity and evidence. Human review must remain human; do not
clear or accept the live ticket merely to unstick a test.

## Recovery

Preparation changes only the isolated candidate checkout. Rolling back this
source repair restores the completed-goal dead end. Preserve pending journals,
goal metadata and receipts; use normal supported release/lifecycle handling for
delivery. This repair changes no storage schema and does not establish recovery
safety for unrelated migrations in the complete release candidate.
