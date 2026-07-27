/// <reference path="../pb_data/types.d.ts" />

// Add the canonical residual name without removing the legacy field. Existing
// self-hosted installations keep backward compatibility with older adapters.
migrate(function (app) {
  var states = app.findCollectionByNameOrId('workflow_state_usage')
  states.fields.add(new Field({
    name: 'unattributed_tokens',
    type: 'number',
    required: false,
    min: 0,
  }))
  app.save(states)
}, function (_app) {
  // Forward-only telemetry schema. Runtime rollback retains recorded evidence.
})
