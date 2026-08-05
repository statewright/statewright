/// <reference path="../pb_data/types.d.ts" />

/**
 * Gateway workflow endpoint — called by statewright-mcp-gateway remote transport.
 * Verifies API key, returns all workflows.
 *
 * GET /api/gateway/workflows
 * Authorization: Bearer sw_...
 *
 * Response: { default: "bugfix", workflows: { ... }, owner_id: "", plan_limit: null }
 */
routerAdd('GET', '/api/gateway/workflows', (e) => {
  // Extract API key from Authorization header
  var auth = e.request.header.get('Authorization') || ''
  var apiKey = auth.replace(/^Bearer\s+/i, '')
  if (!apiKey) {
    return e.json(401, { error: 'Authorization header required' })
  }

  // Hash the key and look it up
  var hash = $security.sha256(apiKey)
  var keyRecord
  try {
    keyRecord = e.app.findFirstRecordByFilter('api_keys', 'key_hash = {:hash}', { hash: hash })
  } catch (_) {
    return e.json(401, { error: 'Invalid API key' })
  }

  if (!keyRecord) {
    return e.json(401, { error: 'Invalid API key' })
  }

  // Update last_used
  keyRecord.set('last_used', new Date().toISOString())
  e.app.save(keyRecord)

  // Fetch all workflows
  var records = e.app.findRecordsByFilter('workflows', '1=1', '-updated', 0, 0)
  var workflows = {}
  var defaultName = ''
  for (var i = 0; i < records.length; i++) {
    var r = records[i]
    var name = r.get('name')
    var def = r.get('definition')
    workflows[name] = def
    if (r.get('active') && !defaultName) {
      defaultName = name
    }
  }

  // If no active workflow, use first available
  if (!defaultName && records.length > 0) {
    defaultName = records[0].get('name')
  }

  return e.json(200, {
    default: defaultName,
    workflows: workflows,
    owner_id: '',
    plan_limit: null,
  })
})

function gatewayKeyFingerprint(e) {
  var auth = e.request.header.get('Authorization') || ''
  var apiKey = auth.replace(/^Bearer\s+/i, '')
  if (!apiKey) return null
  var hash = $security.sha256(apiKey)
  try {
    e.app.findFirstRecordByFilter('api_keys', 'key_hash = {:hash}', { hash: hash })
    return hash
  } catch (_) {
    return null
  }
}

function telemetryNumber(value) {
  return typeof value === 'number' && isFinite(value) && value >= 0 ? value : 0
}

function telemetryText(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function telemetryTokenUsage(value) {
  value = value || {}
  return {
    input_tokens: telemetryNumber(value.input_tokens),
    cache_write_input_tokens: telemetryNumber(value.cache_write_input_tokens),
    cached_input_tokens: telemetryNumber(value.cached_input_tokens),
    output_tokens: telemetryNumber(value.output_tokens),
    reasoning_output_tokens: telemetryNumber(value.reasoning_output_tokens),
    total_tokens: telemetryNumber(value.total_tokens),
  }
}

function findOrCreateTelemetryRun(app, sessionId, workflow, requestedRunId) {
  if (requestedRunId) {
    var existing = null
    try {
      existing = app.findFirstRecordByFilter(
        'workflow_runs',
        'external_run_id = {:run}',
        { run: requestedRunId },
      )
    } catch (_) {}
    if (existing) {
      // Route changes restart the client process, so a valid workflow run
      // can legitimately acquire a new session ID. The external run ID is
      // the stable attribution boundary.
      if (sessionId && existing.get('session_id') !== sessionId) {
        existing.set('session_id', telemetryText(sessionId, 255))
        app.save(existing)
      }
      return existing
    }
    var requestedCollection = app.findCollectionByNameOrId('workflow_runs')
    var requested = new Record(requestedCollection)
    requested.set('workflow_name', telemetryText(workflow, 100) || 'telemetry')
    requested.set('status', 'running')
    requested.set('started_at', new Date().toISOString())
    requested.set('session_id', telemetryText(sessionId, 255))
    requested.set('external_run_id', telemetryText(requestedRunId, 64))
    app.save(requested)
    return requested
  }
  try {
    return app.findFirstRecordByFilter('workflow_runs', 'session_id = {:session}', { session: sessionId })
  } catch (_) {
    var collection = app.findCollectionByNameOrId('workflow_runs')
    var run = new Record(collection)
    run.set('workflow_name', telemetryText(workflow, 100) || 'telemetry')
    run.set('status', 'running')
    run.set('started_at', new Date().toISOString())
    run.set('session_id', telemetryText(sessionId, 255))
    app.save(run)
    return run
  }
}

function projectStateUsage(app, run, fingerprint, event, budget) {
  budget = budget || event.state_budget || {}
  var state = telemetryText(budget.state || event.state, 255)
  var epoch = telemetryNumber(budget.state_epoch)
  if (!state || !epoch) return null
  var collection = app.findCollectionByNameOrId('workflow_state_usage')
  var record
  try {
    record = app.findFirstRecordByFilter(
      'workflow_state_usage',
      'run_id = {:run} && state_epoch = {:epoch}',
      { run: run.id, epoch: epoch },
    )
  } catch (_) {
    record = new Record(collection)
    record.set('run_id', run.id)
    record.set('state_epoch', epoch)
  }
  var usage = telemetryTokenUsage(budget.token_usage)
  var attribution = budget.token_attribution || {}
  record.set('api_key_fingerprint', fingerprint)
  record.set('state', state)
  record.set('provider', telemetryText(budget.provider || event.provider, 100))
  record.set('model', telemetryText(budget.model || event.model, 255))
  record.set('effort', telemetryText(budget.effort || event.effort, 100))
  record.set('precision', telemetryText(budget.precision || event.precision, 32) || 'mixed')
  record.set('token_usage', usage)
  record.set('tool_result_bytes', telemetryNumber(budget.tool_result_bytes))
  record.set('estimated_tool_output_tokens', telemetryNumber(budget.estimated_tool_output_tokens))
  var unattributed = attribution.unattributed_tokens
  if (unattributed === undefined) unattributed = attribution.non_tool_tokens
  record.set('non_tool_tokens', telemetryNumber(unattributed))
  record.set('unattributed_tokens', telemetryNumber(unattributed))
  record.set('reported_reasoning_output_tokens', telemetryNumber(attribution.reported_reasoning_output_tokens))
  record.set('context_budget_bytes', telemetryNumber(budget.context_budget_bytes))
  record.set('context_budget_percent', telemetryNumber(budget.context_budget_percent))
  record.set('tool_count', telemetryNumber(budget.tool_result_count))
  record.set('observed_at', telemetryText(event.timestamp, 64) || new Date().toISOString())
  app.save(record)
  return record
}

// Adapter telemetry is accepted only with an API key and only after being
// projected to a fixed schema. The endpoint intentionally has no generic JSON
// persistence path, so prompts and raw tool payloads cannot enter PocketBase.
routerAdd('POST', '/api/gateway/telemetry/events', function (e) {
  var fingerprint = gatewayKeyFingerprint(e)
  if (!fingerprint) return e.json(401, { error: 'Invalid API key' })
  var body
  try { body = JSON.parse(toString(e.request.body)) } catch (_) { return e.json(400, { error: 'Invalid JSON body' }) }
  var events = body && body.events
  if (!Array.isArray(events) || events.length === 0 || events.length > 100) {
    return e.json(400, { error: 'events must contain 1-100 records' })
  }
  var accepted = 0
  for (var i = 0; i < events.length; i++) {
    var event = events[i] || {}
    var eventId = telemetryText(event.event_id, 64)
    var sessionId = telemetryText(event.thread_id, 255)
    if (!eventId || !sessionId) continue
    try { e.app.findFirstRecordByFilter('workflow_usage_events', 'event_id = {:id}', { id: eventId }); continue } catch (_) {}
    var runSessionId = telemetryText(event.run_session_id, 255) || sessionId
    var run = findOrCreateTelemetryRun(e.app, runSessionId, event.workflow, telemetryText(event.run_id, 255))
    var snapshots = Array.isArray(event.state_usage) ? event.state_usage : [event.state_budget]
    var stateUsage = null
    for (var j = 0; j < snapshots.length; j++) {
      var projected = projectStateUsage(e.app, run, fingerprint, event, snapshots[j])
      if (projected && projected.get('state') === telemetryText(event.state, 255)) stateUsage = projected
    }
    var eventCollection = e.app.findCollectionByNameOrId('workflow_usage_events')
    var entry = new Record(eventCollection)
    entry.set('event_id', eventId)
    entry.set('api_key_fingerprint', fingerprint)
    entry.set('run_id', run.id)
    entry.set('session_id', sessionId)
    entry.set('sequence', telemetryNumber(event.sequence))
    entry.set('event_type', telemetryText(event.event, 100))
    entry.set('state', telemetryText(event.state, 255))
    entry.set('state_epoch', telemetryNumber(event.state_budget && event.state_budget.state_epoch))
    entry.set('payload', { token_usage: telemetryTokenUsage(event.token_usage), token_usage_delta: telemetryTokenUsage(event.token_usage_delta) })
    entry.set('observed_at', telemetryText(event.timestamp, 64) || new Date().toISOString())
    e.app.save(entry)
    if (stateUsage && event.tool && telemetryText(event.tool.tool, 255)) {
      projectToolUsage(e.app, stateUsage, fingerprint, eventId, event.tool, event.timestamp, 'codex_adapter')
    }
    for (var k = 0; k < snapshots.length; k++) {
      var snapshot = snapshots[k] || {}
      var projectedState = projectStateUsage(e.app, run, fingerprint, event, snapshot)
      var tools = snapshot.tools || []
      for (var m = 0; m < tools.length; m++) {
        projectToolUsage(e.app, projectedState, fingerprint, tools[m].invocation_id, tools[m], event.timestamp, tools[m].source)
      }
    }
    accepted++
  }
  return e.json(202, { accepted: accepted })
})

function projectToolUsage(app, stateUsage, fingerprint, invocationId, toolData, observedAt, source) {
  if (!stateUsage || !telemetryText(invocationId, 255) || !telemetryText(toolData && toolData.tool, 255)) return
  try {
    var toolCollection = app.findCollectionByNameOrId('workflow_tool_usage')
    var tool = new Record(toolCollection)
    tool.set('state_usage_id', stateUsage.id)
    tool.set('api_key_fingerprint', fingerprint)
    tool.set('invocation_id', telemetryText(invocationId, 255))
    tool.set('tool', telemetryText(toolData.tool, 255))
    tool.set('tool_type', telemetryText(toolData.tool_type || toolData.type, 100))
    tool.set('source', telemetryText(source, 100))
    tool.set('result_bytes', telemetryNumber(toolData.result_bytes))
    tool.set('estimated_input_tokens', telemetryNumber(toolData.estimated_input_tokens))
    tool.set('is_error', toolData.is_error === true)
    tool.set('observed_at', telemetryText(observedAt, 64) || new Date().toISOString())
    app.save(tool)
  } catch (_) {}
}

function projectWorkflowLog(app, run, log) {
  var phase = telemetryText(log.phase, 255)
  var toolName = telemetryText(log.tool_name, 255)
  if (!phase || !toolName) return null
  var collection = app.findCollectionByNameOrId('workflow_logs')
  var record = new Record(collection)
  record.set('run_id', run.id)
  record.set('phase', phase)
  record.set('tool_name', toolName)
  record.set('tool_input', log.tool_input || {})
  record.set('tool_output', telemetryText(log.tool_output, 102400))
  record.set('sequence', telemetryNumber(log.sequence))
  record.set('duration_ms', telemetryNumber(log.duration_ms))
  app.save(record)
  return record
}

// Raw tool logs are opt-in (`capture_output`). Their run binding follows the
// same authenticated, session-checked resolver as structured usage telemetry.
routerAdd('POST', '/api/gateway/logs', function (e) {
  if (!gatewayKeyFingerprint(e)) return e.json(401, { error: 'Invalid API key' })
  var log
  try { log = JSON.parse(toString(e.request.body)) } catch (_) { return e.json(400, { error: 'Invalid JSON body' }) }
  var sessionId = telemetryText(log.run_session_id, 255) || telemetryText(log.thread_id || log.session_id, 255)
  if (!sessionId) return e.json(400, { error: 'run_session_id or thread_id is required' })
  var run = findOrCreateTelemetryRun(e.app, sessionId, log.workflow, telemetryText(log.run_id, 255))
  var record = projectWorkflowLog(e.app, run, log)
  if (!record) return e.json(400, { error: 'phase and tool_name are required' })
  return e.json(201, { id: record.id, run_id: run.id })
})

routerAdd('GET', '/api/gateway/runs/{runId}/usage', function (e) {
  var fingerprint = gatewayKeyFingerprint(e)
  if (!fingerprint) return e.json(401, { error: 'Invalid API key' })
  var runId = e.request.pathValue('runId')
  try {
    e.app.findRecordById('workflow_runs', runId)
  } catch (_) {
    try {
      runId = e.app.findFirstRecordByFilter(
        'workflow_runs',
        'external_run_id = {:run}',
        { run: runId },
      ).id
    } catch (_) {
      return e.json(404, { error: 'Workflow run not found' })
    }
  }
  var states = e.app.findRecordsByFilter(
    'workflow_state_usage',
    'run_id = {:run} && api_key_fingerprint = {:fingerprint}',
    'state_epoch', 500, 0, { run: runId, fingerprint: fingerprint },
  )
  var result = []
  for (var i = 0; i < states.length; i++) {
    var state = states[i]
    var tools = e.app.findRecordsByFilter(
      'workflow_tool_usage',
      'state_usage_id = {:state} && api_key_fingerprint = {:fingerprint}',
      'created', 500, 0, { state: state.id, fingerprint: fingerprint },
    )
    result.push({ state: state, tools: tools })
  }
  return e.json(200, { run_id: runId, states: result })
})
