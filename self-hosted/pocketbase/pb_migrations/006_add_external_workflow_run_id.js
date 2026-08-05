/// <reference path="../pb_data/types.d.ts" />

// Statewright's gateway run UUID is distinct from PocketBase's record ID.
// Keep that external identity durable so telemetry from a resumed client
// cannot be attributed to an older run sharing the same session ID.
migrate(function (app) {
  var runs = app.findCollectionByNameOrId('workflow_runs')
  runs.fields.add(new Field({
    name: 'external_run_id',
    type: 'text',
    required: false,
    max: 64,
  }))
  runs.indexes.push("CREATE UNIQUE INDEX idx_runs_external_run_id ON workflow_runs (external_run_id) WHERE external_run_id IS NOT NULL AND external_run_id <> ''")
  app.save(runs)
}, function (_app) {
  // Forward-only telemetry identity. Rollback retains recorded run evidence.
})
