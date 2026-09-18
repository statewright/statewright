# ADR 009: version-bound owning Pi interactive gestures

Date: 2026-09-17. Status: intermediate experimental boundary, not P1 activation.
Base998cad2; SDK0.73.0 local source is the compatibility evidence.

The public InteractiveMode options have no configuration-gesture interceptor.
Private instance helpers execute before Session.prompt; extension commands cannot
override these built-ins. Public ModelSelectorComponent.handleSelect writes the
default model before invoking its callback. Guarding only Session.setModel or
creating an input on selection therefore misses invocation order/default writes.

Bind a narrow set of private INSTANCE helpers/selector callback fields on the public SDK classes, with exact
SDK VERSION and required method/component checks that fail closed before run.
This is intentionally a private ABI dependency, not a supported public SDK hook.
No private module imports, SDK/vendor modifications or full UI implementation copy.
Remove this adapter when an equivalent public SDK gesture hook exists; a version
upgrade requires discriminating actual SDK tests and fresh compatibility review.

The native adapter alone receives interactive admission. Capture before registry
waits/selector construction. Delayed callbacks execute under their original
private request and fresh checkpoint, never the latest input. Guard the selector
entry BEFORE its default write and suppress obsolete configuration UI publication.
Cleanup revocation only for the exact still-installed selector; dismissal cancels
the original request immediately even while its checkpoint waits, without
admission or journal clearing. Native UI replacement retires that captured
gesture; remove its cleanup listener before installing the replacement and
recheck the UI token inside the awaited checkpoint before any default write.
Project/unbound callback scope
does not receive native-input authority. Raw configuration guards remain installed.

Model/thinking cycles, model search/selection and name are the bounded cut;
settings/scoped-model edits, all native rendering/provider callbacks, headed UI,
cold restart/lineage, production activation and authorized reviewer journeys are
not covered collectively. Synthetic SDK fixtures are not live human authority
or same-OS isolation. No installed runtime is changed. Roll back with a scoped
commit revert, retaining existing owner/journal records and their evidence.
