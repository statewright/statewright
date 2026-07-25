/// <reference path="../pb_data/types.d.ts" />

// Durable, sanitized execution-usage telemetry. Direct collection access is
// denied; the keyed gateway route projects and reads these records.
migrate(function (app) {
  var events = new Collection({
    name: 'workflow_usage_events', type: 'base',
    listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    fields: [
      { name: 'event_id', type: 'text', required: true, max: 64 },
      { name: 'api_key_fingerprint', type: 'text', required: true, max: 128 },
      { name: 'run_id', type: 'relation', required: false, collectionId: app.findCollectionByNameOrId('workflow_runs').id, cascadeDelete: true, maxSelect: 1 },
      { name: 'session_id', type: 'text', required: false, max: 255 },
      { name: 'sequence', type: 'number', required: false, min: 0 },
      { name: 'event_type', type: 'text', required: true, max: 100 },
      { name: 'state', type: 'text', required: false, max: 255 },
      { name: 'state_epoch', type: 'number', required: false, min: 0 },
      { name: 'payload', type: 'json', required: false, maxSize: 65536 },
      { name: 'observed_at', type: 'text', required: true, max: 64 },
      { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
    ],
    indexes: [
      'CREATE UNIQUE INDEX idx_usage_event_id ON workflow_usage_events (event_id)',
      'CREATE INDEX idx_usage_events_run ON workflow_usage_events (run_id, sequence)',
    ],
  })
  app.save(events)

  var states = new Collection({
    name: 'workflow_state_usage', type: 'base',
    listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    fields: [
      { name: 'run_id', type: 'relation', required: false, collectionId: app.findCollectionByNameOrId('workflow_runs').id, cascadeDelete: true, maxSelect: 1 },
      { name: 'api_key_fingerprint', type: 'text', required: true, max: 128 },
      { name: 'state', type: 'text', required: true, max: 255 },
      { name: 'state_epoch', type: 'number', required: true, min: 0 },
      { name: 'provider', type: 'text', required: false, max: 100 },
      { name: 'model', type: 'text', required: false, max: 255 },
      { name: 'effort', type: 'text', required: false, max: 100 },
      { name: 'precision', type: 'text', required: false, max: 32 },
      { name: 'token_usage', type: 'json', required: false, maxSize: 8192 },
      { name: 'tool_result_bytes', type: 'number', required: false, min: 0 },
      { name: 'estimated_tool_output_tokens', type: 'number', required: false, min: 0 },
      { name: 'non_tool_tokens', type: 'number', required: false, min: 0 },
      { name: 'reported_reasoning_output_tokens', type: 'number', required: false, min: 0 },
      { name: 'context_budget_bytes', type: 'number', required: false, min: 0 },
      { name: 'context_budget_percent', type: 'number', required: false, min: 0 },
      { name: 'tool_count', type: 'number', required: false, min: 0 },
      { name: 'transition', type: 'json', required: false, maxSize: 8192 },
      { name: 'observed_at', type: 'text', required: true, max: 64 },
      { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
      { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
    ],
    indexes: ['CREATE UNIQUE INDEX idx_state_usage_epoch ON workflow_state_usage (run_id, state_epoch)'],
  })
  app.save(states)

  var tools = new Collection({
    name: 'workflow_tool_usage', type: 'base',
    listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    fields: [
      { name: 'state_usage_id', type: 'relation', required: false, collectionId: states.id, cascadeDelete: true, maxSelect: 1 },
      { name: 'api_key_fingerprint', type: 'text', required: true, max: 128 },
      { name: 'invocation_id', type: 'text', required: true, max: 255 },
      { name: 'tool', type: 'text', required: true, max: 255 },
      { name: 'tool_type', type: 'text', required: false, max: 100 },
      { name: 'source', type: 'text', required: false, max: 100 },
      { name: 'result_bytes', type: 'number', required: false, min: 0 },
      { name: 'estimated_input_tokens', type: 'number', required: false, min: 0 },
      { name: 'is_error', type: 'bool', required: false },
      { name: 'observed_at', type: 'text', required: true, max: 64 },
      { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
    ],
    indexes: ['CREATE UNIQUE INDEX idx_tool_usage_invocation ON workflow_tool_usage (api_key_fingerprint, invocation_id)'],
  })
  app.save(tools)
}, function (app) {
  var names = ['workflow_tool_usage', 'workflow_state_usage', 'workflow_usage_events']
  for (var i = 0; i < names.length; i++) {
    try { app.delete(app.findCollectionByNameOrId(names[i])) } catch (_) {}
  }
})
