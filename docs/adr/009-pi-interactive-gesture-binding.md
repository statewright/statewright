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

Slice19 extends this binding to settings/submenus and scoped-model configuration.
SettingsList input changes local values before callbacks; scoped model input
does not await its async callback. Guard the native input boundary, retain exact
UI-token ownership across awaited callbacks and serialize changes; stage/restore
local UI during waits and publish only after successful guarded mutation. Restore
nested settings/select-list values and warning state too. Warning submenu's native
closure changes before persistence; rehydrate the native submenu from current
public SettingsManager warnings when reopening, with explicit0.73.0 field checks.
This preserves native callbacks while rejecting false-success after failure. Native
scoped onChange has no checkpoint after its private resolver await; replace only
that callback with public registry/session primitives using literal UI-generated
IDs and immutable model snapshot, then private original-reference effect checkpoint
before synchronous setScopedModels. Keep native component/input/save behavior.
Queue native selector factories until their helper returns, then checkpoint before
constructing/displaying them; SDK ignores showSelector's return, so a promise at
that method alone would be insufficient. No latest input or arbitrary resolver
pattern is adopted. Preview/navigation and whole backend FX atomicity remain
bounded by native semantics, not a transactional persistence claim. Native
submenu cancellation is audited UI resource cleanup (including preview restore),
not new configuration effect authority. Whole-frame dismissal cancels immediately.
Scoped selector is mode-created but not SDK-public-exported; VERSION0.73.0 and
private constructor/field checks are explicit compatibility dependencies, not a
reason to import private modules. Raw project settings/UI/registry APIs remain
an open effect boundary rather than being implicitly authorized by this adapter.

Model/thinking cycles, model search/selection, name and these configuration
gestures are the bounded cuts; all native rendering/provider callbacks, headed UI,
cold restart/lineage, production activation and authorized reviewer journeys are
not covered collectively. Synthetic SDK fixtures are not live human authority
or same-OS isolation. No installed runtime is changed. Roll back with a scoped
commit revert, retaining existing owner/journal records and their evidence.
