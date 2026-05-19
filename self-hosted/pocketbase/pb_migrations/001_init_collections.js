/// <reference path="../pb_data/types.d.ts" />

/**
 * Self-hosted Statewright — all collections with public API rules.
 * No users collection. No auth. Network access = full access.
 */
migrate((app) => {
  // --- workflows ---
  const workflows = new Collection({
    name: 'workflows',
    type: 'base',
    listRule: '',
    viewRule: '',
    createRule: '',
    updateRule: '',
    deleteRule: '',
    fields: [
      { name: 'name', type: 'text', required: true, min: 1, max: 100 },
      { name: 'version', type: 'text', required: false, max: 20 },
      { name: 'definition', type: 'json', required: true, maxSize: 1048576 },
      { name: 'template_source', type: 'text', required: false, max: 100 },
      { name: 'active', type: 'bool', required: false },
      { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
      { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
    ],
    indexes: [
      'CREATE UNIQUE INDEX idx_workflows_name ON workflows (name)',
    ],
  })
  app.save(workflows)

  // --- workflow_runs ---
  const runs = new Collection({
    name: 'workflow_runs',
    type: 'base',
    listRule: '',
    viewRule: '',
    createRule: '',
    updateRule: '',
    deleteRule: '',
    fields: [
      { name: 'workflow_name', type: 'text', required: true },
      { name: 'status', type: 'text', required: true },
      { name: 'started_at', type: 'text', required: true },
      { name: 'completed_at', type: 'text', required: false },
      { name: 'final_state', type: 'text', required: false },
      { name: 'transitions', type: 'json', required: false, maxSize: 1048576 },
      { name: 'transition_count', type: 'number', required: false, min: 0 },
      { name: 'session_id', type: 'text', required: false },
      { name: 'project_id', type: 'text', required: false },
      { name: 'context_snapshot', type: 'json', required: false, maxSize: 1048576 },
      { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
      { name: 'updated', type: 'autodate', onCreate: true, onUpdate: true },
    ],
    indexes: [
      'CREATE INDEX idx_runs_session ON workflow_runs (session_id)',
      'CREATE INDEX idx_runs_status ON workflow_runs (status)',
    ],
  })
  app.save(runs)

  // --- workflow_logs ---
  const logs = new Collection({
    name: 'workflow_logs',
    type: 'base',
    listRule: '',
    viewRule: '',
    createRule: '',
    updateRule: '',
    deleteRule: '',
    fields: [
      { name: 'run_id', type: 'relation', required: false, collectionId: runs.id, cascadeDelete: true, maxSelect: 1 },
      { name: 'phase', type: 'text', required: true },
      { name: 'tool_name', type: 'text', required: true },
      { name: 'tool_input', type: 'json', required: false, maxSize: 65536 },
      { name: 'tool_output', type: 'json', required: false, maxSize: 1048576 },
      { name: 'sequence', type: 'number', required: false, min: 0 },
      { name: 'duration_ms', type: 'number', required: false, min: 0 },
      { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
    ],
    indexes: [
      'CREATE INDEX idx_logs_run ON workflow_logs (run_id)',
      'CREATE INDEX idx_logs_phase ON workflow_logs (run_id, phase)',
    ],
  })
  app.save(logs)

  // --- api_keys ---
  const keys = new Collection({
    name: 'api_keys',
    type: 'base',
    listRule: '',
    viewRule: '',
    createRule: '',
    updateRule: '',
    deleteRule: '',
    fields: [
      { name: 'key_hash', type: 'text', required: true },
      { name: 'name', type: 'text', required: false, max: 100 },
      { name: 'prefix', type: 'text', required: false, max: 12 },
      { name: 'last_used', type: 'date', required: false },
      { name: 'created', type: 'autodate', onCreate: true, onUpdate: false },
    ],
    indexes: [
      'CREATE UNIQUE INDEX idx_api_keys_hash ON api_keys (key_hash)',
    ],
  })
  app.save(keys)

  // --- workflow_templates ---
  const templates = new Collection({
    name: 'workflow_templates',
    type: 'base',
    listRule: '',
    viewRule: '',
    createRule: '',
    updateRule: '',
    deleteRule: '',
    fields: [
      { name: 'name', type: 'text', required: true, min: 1, max: 100 },
      { name: 'description', type: 'text', required: false, max: 500 },
      { name: 'definition', type: 'json', required: true, maxSize: 1048576 },
      { name: 'sort_order', type: 'number', required: false, min: 0 },
      { name: 'active', type: 'bool', required: false },
    ],
    indexes: [
      'CREATE UNIQUE INDEX idx_wf_templates_name ON workflow_templates (name)',
    ],
  })
  app.save(templates)

  // --- Seed templates ---
  var seeds = [
    {
      name: 'bugfix',
      description: 'Plan, implement, test. Enforces read-before-write and test-before-complete.',
      sort_order: 1,
      active: true,
      definition: {
        id: 'bugfix', initial: 'planning',
        states: {
          planning: { allowed_tools: ['Read', 'Grep', 'Glob'], instructions: 'Read the relevant code and understand the bug before making changes.', max_iterations: 8, safe_next: 'implementing', on: { READY: 'implementing', FAIL: 'failed' } },
          implementing: { allowed_tools: ['Read', 'Edit', 'Write'], instructions: 'Make the minimal fix. Do not refactor unrelated code.', max_iterations: 10, max_edit_lines: 20, max_files_per_state: 3, on: { DONE: 'testing', FAIL: 'failed' } },
          testing: { allowed_tools: ['Read', 'Bash'], allowed_commands: ['pytest', 'cargo test', 'npm test', 'npx vitest', 'go test', 'make test'], instructions: 'Run the test suite. If tests fail, transition back to implementing.', max_iterations: 5, on: { PASS: 'completed', FAIL_TEST: 'implementing', FAIL: 'failed' } },
          completed: { type: 'final' },
          failed: { type: 'final' },
        },
        guards: {},
      },
    },
    {
      name: 'etl-pipeline',
      description: 'Extract, validate, transform, load. No writes until validation passes.',
      sort_order: 2,
      active: true,
      definition: {
        id: 'etl-pipeline', initial: 'extracting',
        states: {
          extracting: { allowed_tools: ['Read', 'Bash', 'Grep'], max_iterations: 10, on: { EXTRACTED: 'validating', FAIL: 'failed' } },
          validating: { allowed_tools: ['Read', 'Bash'], allowed_commands: ['python', 'node', 'jq'], max_iterations: 5, on: { VALID: 'transforming', INVALID: 'failed' } },
          transforming: { allowed_tools: ['Read', 'Edit', 'Write', 'Bash'], max_edit_lines: 50, max_iterations: 15, on: { TRANSFORMED: 'loading', FAIL: 'failed' } },
          loading: { allowed_tools: ['Bash'], max_iterations: 5, on: { LOADED: 'completed', FAIL: 'failed' } },
          completed: { type: 'final' },
          failed: { type: 'final' },
        },
        guards: {},
      },
    },
    {
      name: 'code-review',
      description: 'Read, analyze, report. No edits allowed.',
      sort_order: 3,
      active: true,
      definition: {
        id: 'code-review', initial: 'reading',
        states: {
          reading: { allowed_tools: ['Read', 'Grep', 'Glob'], max_iterations: 15, context_budget_bytes: 100000, on: { READ: 'analyzing', FAIL: 'failed' } },
          analyzing: { allowed_tools: ['Read', 'Grep'], max_iterations: 10, on: { ANALYZED: 'reporting', FAIL: 'failed' } },
          reporting: { allowed_tools: ['Write'], max_files_per_state: 1, max_iterations: 3, on: { REPORTED: 'completed', FAIL: 'failed' } },
          completed: { type: 'final' },
          failed: { type: 'final' },
        },
        guards: {},
      },
    },
    {
      name: 'support-triage',
      description: 'Classify, investigate, respond. Approval gate before customer-facing actions.',
      sort_order: 4,
      active: true,
      definition: {
        id: 'support-triage', initial: 'classifying',
        states: {
          classifying: { allowed_tools: ['Read'], max_iterations: 3, on: { CLASSIFIED: 'investigating', FAIL: 'failed' } },
          investigating: { allowed_tools: ['Read', 'Grep', 'Bash'], allowed_commands: ['curl', 'psql', 'mongosh'], max_iterations: 10, on: { READY_TO_RESPOND: 'responding', ESCALATE: 'escalated', FAIL: 'failed' } },
          responding: { allowed_tools: ['Write'], max_files_per_state: 1, max_iterations: 3, on: { SENT: 'completed', FAIL: 'failed' } },
          escalated: { type: 'final' },
          completed: { type: 'final' },
          failed: { type: 'final' },
        },
        guards: {},
      },
    },
  ]

  for (var i = 0; i < seeds.length; i++) {
    var t = seeds[i]
    var rec = new Record(templates)
    rec.set('name', t.name)
    rec.set('description', t.description)
    rec.set('definition', t.definition)
    rec.set('sort_order', t.sort_order)
    rec.set('active', t.active)
    app.save(rec)
  }
  console.log('Created 5 collections, seeded ' + seeds.length + ' templates')
}, (app) => {
  var names = ['workflow_logs', 'workflow_runs', 'workflows', 'api_keys', 'workflow_templates']
  for (var i = 0; i < names.length; i++) {
    try { app.delete(app.findCollectionByNameOrId(names[i])) } catch (e) {}
  }
})
