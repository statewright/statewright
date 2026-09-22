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
    if (def && def.meta && def.meta.enabled === false) {
      continue
    }
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

function telemetryHas(object, field) {
  return object && Object.prototype.hasOwnProperty.call(object, field)
}

function telemetryObject(value) {
  if (!value) return {}
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch (_) { return {} }
  } else {
    value = JSON.parse(JSON.stringify(value))
  }
  return !Array.isArray(value) && typeof value === 'object' ? value : {}
}

function findOrCreateTelemetryRun(app, sessionId, workflow, requestedRunId, fingerprint) {
  if (requestedRunId) {
    var existing = null
    try {
      // Statewright's workflow endpoint returns the PocketBase record ID. Raw
      // tool telemetry carries that authoritative ID, while some adapters use
      // an external run ID. Resolve the primary record first so a run does not
      // split into a state-only record and a telemetry-only shadow record.
      existing = app.findRecordById('workflow_runs', requestedRunId)
    } catch (_) {}
    if (existing && (existing.get('telemetry_ownership_status') === 'ambiguous' || existing.get('api_key_fingerprint') !== fingerprint)) return null
    if (!existing) {
      try {
        existing = app.findFirstRecordByFilter(
          'workflow_runs',
          'external_run_id = {:run} && api_key_fingerprint = {:fingerprint}',
          { run: requestedRunId, fingerprint: fingerprint },
        )
      } catch (_) {}
    }
    if (existing) {
      return existing
    }
    var requestedCollection = app.findCollectionByNameOrId('workflow_runs')
    var requested = new Record(requestedCollection)
    requested.set('workflow_name', telemetryText(workflow, 100) || 'telemetry')
    requested.set('status', 'running')
    requested.set('started_at', new Date().toISOString())
    requested.set('session_id', telemetryText(sessionId, 255))
    requested.set('external_run_id', telemetryText(requestedRunId, 64))
    requested.set('api_key_fingerprint', fingerprint)
    requested.set('telemetry_ownership_status', 'bound')
    app.save(requested)
    return requested
  }
  try {
    return app.findFirstRecordByFilter(
      'workflow_runs',
      'session_id = {:session} && api_key_fingerprint = {:fingerprint}',
      { session: sessionId, fingerprint: fingerprint },
    )
  } catch (_) {
    var collection = app.findCollectionByNameOrId('workflow_runs')
    var run = new Record(collection)
    run.set('workflow_name', telemetryText(workflow, 100) || 'telemetry')
    run.set('status', 'running')
    run.set('started_at', new Date().toISOString())
    run.set('session_id', telemetryText(sessionId, 255))
    run.set('api_key_fingerprint', fingerprint)
    run.set('telemetry_ownership_status', 'bound')
    app.save(run)
    return run
  }
}

function telemetryPrecisionRank(precision) {
  if (precision === 'exact') return 3
  if (precision === 'mixed') return 2
  if (precision === 'estimated') return 1
  return 0
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
  if (record.id && record.get('api_key_fingerprint') !== fingerprint) return null
  var channel = telemetryText(event.source || event.provider, 100) || 'adapter'
  var sequence = telemetryNumber(event.sequence)
  if (!sequence) return null
  var priorEvents = app.findRecordsByFilter(
    'workflow_usage_events',
    'run_id = {:run} && state_epoch = {:epoch} && source = {:source}',
    '-sequence',
    1,
    0,
    { run: run.id, epoch: epoch, source: channel },
  )
  if (priorEvents.length && sequence <= telemetryNumber(priorEvents[0].get('sequence'))) throw new Error('STALE_SEQUENCE')
  var cursors = telemetryObject(record.getRaw('sequence_cursors'))
  if (sequence && sequence <= telemetryNumber(cursors[channel])) return record
  var usage = telemetryTokenUsage(budget.token_usage)
  var attribution = budget.token_attribution || {}
  var precision = telemetryText(budget.precision || event.precision, 32) || 'mixed'
  var priorPrecision = telemetryText(record.get('precision'), 32) || 'unavailable'
  var priorUsage = telemetryTokenUsage(record.get('token_usage'))
  var applies = telemetryPrecisionRank(precision) > telemetryPrecisionRank(priorPrecision) ||
    (telemetryPrecisionRank(precision) === telemetryPrecisionRank(priorPrecision) &&
      usage.total_tokens >= priorUsage.total_tokens)
  if (!applies) {
    cursors[channel] = sequence
    record.set('sequence_cursors', cursors)
    app.save(record)
    return record
  }
  record.set('api_key_fingerprint', fingerprint)
  record.set('state', state)
  record.set('provider', telemetryText(budget.provider || event.provider, 100))
  record.set('model', telemetryText(budget.model || event.model, 255))
  record.set('effort', telemetryText(budget.effort || event.effort, 100))
  record.set('precision', precision)
  record.set('token_usage', usage)
  if (telemetryHas(budget, 'tool_result_bytes')) record.set('tool_result_bytes', telemetryNumber(budget.tool_result_bytes))
  if (telemetryHas(budget, 'estimated_tool_output_tokens')) record.set('estimated_tool_output_tokens', telemetryNumber(budget.estimated_tool_output_tokens))
  var unattributed = attribution.unattributed_tokens
  if (unattributed === undefined) unattributed = attribution.non_tool_tokens
  if (unattributed !== undefined) {
    record.set('non_tool_tokens', telemetryNumber(unattributed))
    record.set('unattributed_tokens', telemetryNumber(unattributed))
  }
  if (telemetryHas(attribution, 'reported_reasoning_output_tokens')) record.set('reported_reasoning_output_tokens', telemetryNumber(attribution.reported_reasoning_output_tokens))
  if (telemetryHas(budget, 'context_budget_bytes')) record.set('context_budget_bytes', telemetryNumber(budget.context_budget_bytes))
  if (telemetryHas(budget, 'context_budget_percent')) record.set('context_budget_percent', telemetryNumber(budget.context_budget_percent))
  if (telemetryHas(budget, 'tool_result_count')) record.set('tool_count', telemetryNumber(budget.tool_result_count))
  if (sequence) {
    cursors[channel] = sequence
    record.set('sequence_cursors', cursors)
  }
  record.set('observed_at', telemetryText(event.timestamp, 64) || new Date().toISOString())
  app.save(record)
  return record
}

// Adapter telemetry is accepted only with an API key and only after being
// projected to a fixed schema. The endpoint intentionally has no generic JSON
// persistence path, so prompts and raw tool payloads cannot enter PocketBase.
function persistTelemetryEvent(app, event, fingerprint) {
  var eventId = telemetryText(event.event_id, 64)
  var sessionId = telemetryText(event.thread_id, 255)
  if (!eventId || !sessionId) return 'invalid'
  try {
    app.findFirstRecordByFilter(
      'workflow_usage_events',
      'event_id = {:id} && api_key_fingerprint = {:fingerprint}',
      { id: eventId, fingerprint: fingerprint },
    )
    return 'duplicate'
  } catch (_) {}
  var runSessionId = telemetryText(event.run_session_id, 255) || sessionId
  var run = findOrCreateTelemetryRun(app, runSessionId, event.workflow, telemetryText(event.run_id, 255), fingerprint)
  if (!run) return 'foreign'
  var snapshots = Array.isArray(event.state_usage) ? event.state_usage : [event.state_budget]
  var projectedStates = []
  var stateUsage = null
  for (var j = 0; j < snapshots.length; j++) {
    var projected = projectStateUsage(app, run, fingerprint, event, snapshots[j])
    projectedStates.push(projected)
    if (projected && projected.get('state') === telemetryText(event.state, 255)) stateUsage = projected
  }
  var eventCollection = app.findCollectionByNameOrId('workflow_usage_events')
  var entry = new Record(eventCollection)
  entry.set('event_id', eventId)
  entry.set('api_key_fingerprint', fingerprint)
  entry.set('run_id', run.id)
  entry.set('session_id', sessionId)
  entry.set('sequence', telemetryNumber(event.sequence))
  entry.set('source', telemetryText(event.source || event.provider, 100) || 'adapter')
  entry.set('event_type', telemetryText(event.event, 100))
  entry.set('state', telemetryText(event.state, 255))
  entry.set('state_epoch', telemetryNumber(event.state_budget && event.state_budget.state_epoch))
  entry.set('payload', { token_usage: telemetryTokenUsage(event.token_usage), token_usage_delta: telemetryTokenUsage(event.token_usage_delta) })
  entry.set('observed_at', telemetryText(event.timestamp, 64) || new Date().toISOString())
  app.save(entry)
  if (stateUsage && event.tool && telemetryText(event.tool.tool, 255)) {
    projectToolUsage(app, stateUsage, fingerprint, eventId, event.tool, event.timestamp, 'codex_adapter')
  }
  for (var k = 0; k < snapshots.length; k++) {
    var snapshot = snapshots[k] || {}
    var tools = snapshot.tools || []
    for (var m = 0; m < tools.length; m++) {
      projectToolUsage(app, projectedStates[k], fingerprint, tools[m].invocation_id, tools[m], event.timestamp, tools[m].source)
    }
  }
  return 'accepted'
}

routerAdd('POST', '/api/gateway/telemetry/events', function (e) {
  // PocketBase route callbacks execute in an isolated JSVM callback scope, so
  // every helper used by the callback is intentionally local.
  function telemetryNumber(value) { return typeof value === 'number' && isFinite(value) && value >= 0 ? value : 0 }
  function telemetryText(value, max) { return typeof value === 'string' ? value.slice(0, max) : '' }
  function telemetryHas(object, field) { return object && Object.prototype.hasOwnProperty.call(object, field) }
  function telemetryObject(value) {
    if (!value) return {}
    if (typeof value === 'string') {
      try { value = JSON.parse(value) } catch (_) { return {} }
    } else {
      value = JSON.parse(JSON.stringify(value))
    }
    return !Array.isArray(value) && typeof value === 'object' ? value : {}
  }
  function telemetrySafeCount(value) {
    return typeof value === 'number' && isFinite(value) && value >= 0 && Math.floor(value) === value && value <= 9007199254740991
  }
  function telemetryTokenUsage(value) {
    value = value || {}
    return {
      input_tokens: telemetryNumber(value.input_tokens), cache_write_input_tokens: telemetryNumber(value.cache_write_input_tokens),
      cached_input_tokens: telemetryNumber(value.cached_input_tokens), output_tokens: telemetryNumber(value.output_tokens),
      reasoning_output_tokens: telemetryNumber(value.reasoning_output_tokens), total_tokens: telemetryNumber(value.total_tokens),
    }
  }
  function gatewayKeyFingerprint(event) {
    var auth = event.request.header.get('Authorization') || ''
    var apiKey = auth.replace(/^Bearer\s+/i, '')
    if (!apiKey) return null
    var hash = $security.sha256(apiKey)
    try { event.app.findFirstRecordByFilter('api_keys', 'key_hash = {:hash}', { hash: hash }); return hash } catch (_) { return null }
  }
  function precisionRank(precision) {
    if (precision === 'exact') return 3
    if (precision === 'mixed') return 2
    if (precision === 'estimated') return 1
    return 0
  }
  function runFor(app, sessionId, workflow, requestedRunId, owner) {
    if (requestedRunId) {
      var existing = null
      try { existing = app.findRecordById('workflow_runs', requestedRunId) } catch (_) {}
      if (existing && (existing.get('telemetry_ownership_status') === 'ambiguous' || existing.get('api_key_fingerprint') !== owner)) return null
      if (!existing) {
        try { existing = app.findFirstRecordByFilter('workflow_runs', 'external_run_id = {:run} && api_key_fingerprint = {:owner}', { run: requestedRunId, owner: owner }) } catch (_) {}
      }
      if (existing) return existing
      var requested = new Record(app.findCollectionByNameOrId('workflow_runs'))
      requested.set('workflow_name', telemetryText(workflow, 100) || 'telemetry')
      requested.set('status', 'running'); requested.set('started_at', new Date().toISOString())
      requested.set('session_id', telemetryText(sessionId, 255)); requested.set('external_run_id', telemetryText(requestedRunId, 64))
      requested.set('api_key_fingerprint', owner); requested.set('telemetry_ownership_status', 'bound'); app.save(requested)
      return requested
    }
    try { return app.findFirstRecordByFilter('workflow_runs', 'session_id = {:session} && api_key_fingerprint = {:owner}', { session: sessionId, owner: owner }) } catch (_) {
      var run = new Record(app.findCollectionByNameOrId('workflow_runs'))
      run.set('workflow_name', telemetryText(workflow, 100) || 'telemetry'); run.set('status', 'running')
      run.set('started_at', new Date().toISOString()); run.set('session_id', telemetryText(sessionId, 255))
      run.set('api_key_fingerprint', owner); run.set('telemetry_ownership_status', 'bound'); app.save(run); return run
    }
  }
  function projectState(app, run, owner, event, budget) {
    budget = budget || event.state_budget || {}
    var state = telemetryText(budget.state || event.state, 255); var epoch = telemetryNumber(budget.state_epoch)
    if (!state || !epoch) return null
    var record
    try { record = app.findFirstRecordByFilter('workflow_state_usage', 'run_id = {:run} && state_epoch = {:epoch}', { run: run.id, epoch: epoch }) } catch (_) {
      record = new Record(app.findCollectionByNameOrId('workflow_state_usage')); record.set('run_id', run.id); record.set('state_epoch', epoch)
    }
    if (record.id && record.get('api_key_fingerprint') !== owner) return null
    if (record.id) {
      var existingState = telemetryText(record.get('state'), 255)
      if (existingState && existingState !== state) throw new Error('STATE_EPOCH_MISMATCH')
    }
    var channel = telemetryText(event.source || event.provider, 100) || 'adapter'; var sequence = telemetryNumber(event.sequence)
    if (!sequence) return null
    var priorEvents = app.findRecordsByFilter('workflow_usage_events', 'run_id = {:run} && state_epoch = {:epoch} && source = {:source}', '-sequence', 1, 0, { run: run.id, epoch: epoch, source: channel })
    if (priorEvents.length && sequence <= telemetryNumber(priorEvents[0].get('sequence'))) throw new Error('STALE_SEQUENCE')
    var cursors = telemetryObject(record.getRaw('sequence_cursors'))
    if (sequence <= telemetryNumber(cursors[channel])) throw new Error('STALE_SEQUENCE')
    var usage = telemetryTokenUsage(budget.token_usage); var attribution = budget.token_attribution || {}
    var precision = telemetryText(budget.precision || event.precision, 32) || 'mixed'
    var priorPrecision = telemetryText(record.get('precision'), 32) || 'unavailable'; var priorUsage = telemetryTokenUsage(record.get('token_usage'))
    var applies = precisionRank(precision) > precisionRank(priorPrecision) || (precisionRank(precision) === precisionRank(priorPrecision) && usage.total_tokens >= priorUsage.total_tokens)
    cursors[channel] = sequence; record.set('sequence_cursors', cursors)
    if (!applies) { app.save(record); return record }
    record.set('api_key_fingerprint', owner); record.set('state', state)
    record.set('provider', telemetryText(budget.provider || event.provider, 100)); record.set('model', telemetryText(budget.model || event.model, 255))
    record.set('effort', telemetryText(budget.effort || event.effort, 100)); record.set('precision', precision); record.set('token_usage', usage)
    if (telemetryHas(budget, 'tool_result_bytes')) record.set('tool_result_bytes', telemetryNumber(budget.tool_result_bytes))
    if (telemetryHas(budget, 'estimated_tool_output_tokens')) record.set('estimated_tool_output_tokens', telemetryNumber(budget.estimated_tool_output_tokens))
    var unattributed = attribution.unattributed_tokens
    if (unattributed === undefined) unattributed = attribution.non_tool_tokens
    if (unattributed !== undefined) { record.set('non_tool_tokens', telemetryNumber(unattributed)); record.set('unattributed_tokens', telemetryNumber(unattributed)) }
    if (telemetryHas(attribution, 'reported_reasoning_output_tokens')) record.set('reported_reasoning_output_tokens', telemetryNumber(attribution.reported_reasoning_output_tokens))
    if (telemetryHas(budget, 'context_budget_bytes')) record.set('context_budget_bytes', telemetryNumber(budget.context_budget_bytes))
    if (telemetryHas(budget, 'context_budget_percent')) record.set('context_budget_percent', telemetryNumber(budget.context_budget_percent))
    if (telemetryHas(budget, 'tool_result_count')) record.set('tool_count', telemetryNumber(budget.tool_result_count))
    record.set('observed_at', telemetryText(event.timestamp, 64) || new Date().toISOString()); app.save(record); return record
  }
  function validExactEvent(event) {
    var precision = telemetryText((event.state_budget || {}).precision || event.precision, 32)
    if (event.event !== 'provider_token_usage' && precision !== 'exact') return true
    var budget = event.state_budget
    if (!budget || typeof budget !== 'object' || Array.isArray(budget)) return false
    var state = telemetryText(event.state, 255)
    var budgetState = telemetryText(budget.state, 255)
    var epoch = telemetryNumber(budget.state_epoch)
    var sequence = telemetryNumber(event.sequence)
    var usage = budget.token_usage
    var tokenFields = ['input_tokens', 'cache_write_input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens']
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return false
    for (var i = 0; i < tokenFields.length; i++) {
      var field = tokenFields[i]
      if (telemetryHas(usage, field) && !telemetrySafeCount(usage[field])) return false
    }
    return !!telemetryText(event.run_id, 255) &&
      !!state && budgetState === state && epoch >= 1 && Math.floor(epoch) === epoch &&
      sequence >= 1 && Math.floor(sequence) === sequence &&
      !!telemetryText(budget.provider || event.provider, 100) &&
      telemetrySafeCount(usage.total_tokens)
  }
  function projectTool(app, stateUsage, owner, invocationId, toolData, observedAt, source) {
    if (!stateUsage || !telemetryText(invocationId, 255) || !telemetryText(toolData && toolData.tool, 255)) return
    try {
      var tool = new Record(app.findCollectionByNameOrId('workflow_tool_usage'))
      tool.set('state_usage_id', stateUsage.id); tool.set('api_key_fingerprint', owner); tool.set('invocation_id', telemetryText(invocationId, 255))
      tool.set('tool', telemetryText(toolData.tool, 255)); tool.set('tool_type', telemetryText(toolData.tool_type || toolData.type, 100)); tool.set('source', telemetryText(source, 100))
      tool.set('result_bytes', telemetryNumber(toolData.result_bytes)); tool.set('estimated_input_tokens', telemetryNumber(toolData.estimated_input_tokens)); tool.set('is_error', toolData.is_error === true)
      tool.set('observed_at', telemetryText(observedAt, 64) || new Date().toISOString()); app.save(tool)
    } catch (_) {}
  }
  function persist(app, event, owner) {
    var eventId = telemetryText(event.event_id, 64); var sessionId = telemetryText(event.thread_id, 255)
    if (!eventId || !sessionId || !validExactEvent(event)) return 'invalid'
    try { app.findFirstRecordByFilter('workflow_usage_events', 'event_id = {:id} && api_key_fingerprint = {:owner}', { id: eventId, owner: owner }); return 'duplicate' } catch (_) {}
    var run = runFor(app, telemetryText(event.run_session_id, 255) || sessionId, event.workflow, telemetryText(event.run_id, 255), owner)
    if (!run) return 'foreign'
    var snapshots = Array.isArray(event.state_usage) ? event.state_usage : [event.state_budget]; var projected = []; var matching = null
    for (var i = 0; i < snapshots.length; i++) { var stateUsage = projectState(app, run, owner, event, snapshots[i]); projected.push(stateUsage); if (stateUsage && stateUsage.get('state') === telemetryText(event.state, 255)) matching = stateUsage }
    if ((event.event === 'provider_token_usage' || telemetryText((event.state_budget || {}).precision || event.precision, 32) === 'exact') && !matching) {
      throw new Error('EXACT_PROJECTION_MISSING')
    }
    var entry = new Record(app.findCollectionByNameOrId('workflow_usage_events'))
    entry.set('event_id', eventId); entry.set('api_key_fingerprint', owner); entry.set('run_id', run.id); entry.set('session_id', sessionId)
    entry.set('sequence', telemetryNumber(event.sequence)); entry.set('event_type', telemetryText(event.event, 100)); entry.set('state', telemetryText(event.state, 255))
    entry.set('source', telemetryText(event.source || event.provider, 100) || 'adapter')
    entry.set('state_epoch', telemetryNumber(event.state_budget && event.state_budget.state_epoch)); entry.set('payload', { token_usage: telemetryTokenUsage(event.token_usage), token_usage_delta: telemetryTokenUsage(event.token_usage_delta) })
    entry.set('observed_at', telemetryText(event.timestamp, 64) || new Date().toISOString()); app.save(entry)
    if (matching && event.tool && telemetryText(event.tool.tool, 255)) projectTool(app, matching, owner, eventId, event.tool, event.timestamp, 'codex_adapter')
    for (var j = 0; j < snapshots.length; j++) { var tools = (snapshots[j] || {}).tools || []; for (var k = 0; k < tools.length; k++) projectTool(app, projected[j], owner, tools[k].invocation_id, tools[k], event.timestamp, tools[k].source) }
    return 'accepted'
  }
  var fingerprint = gatewayKeyFingerprint(e)
  if (!fingerprint) return e.json(401, { error: 'Invalid API key' })
  var body
  try { body = JSON.parse(toString(e.request.body)) } catch (_) { return e.json(400, { error: 'Invalid JSON body' }) }
  var events = body && body.events
  if (!Array.isArray(events) || events.length === 0 || events.length > 100) {
    return e.json(400, { error: 'events must contain 1-100 records' })
  }
  var accepted = 0
  var acceptedEventIds = []
  var duplicateEventIds = []
  for (var i = 0; i < events.length; i++) {
    var event = events[i] || {}
    var result
    try {
      e.app.runInTransaction(function (txApp) {
        result = persist(txApp, event, fingerprint)
      })
    } catch (error) {
      console.log('Telemetry transaction failed: ' + error)
      var message = String(error)
      if (message.indexOf('STATE_EPOCH_MISMATCH') >= 0) return e.json(409, { error: 'state_epoch_mismatch', event_id: telemetryText(event.event_id, 64) })
      if (message.indexOf('EXACT_PROJECTION_MISSING') >= 0) return e.json(409, { error: 'exact_projection_missing', event_id: telemetryText(event.event_id, 64) })
      if (message.indexOf('STALE_SEQUENCE') >= 0) return e.json(409, { error: 'stale_sequence', event_id: telemetryText(event.event_id, 64) })
      return e.json(409, { error: 'Telemetry projection conflicted; retry the event' })
    }
    if (result === 'foreign') return e.json(409, { error: 'Workflow run belongs to another API key' })
    if (result === 'invalid') return e.json(400, { error: 'Invalid telemetry event identity or state budget', event_id: telemetryText(event.event_id, 64) })
    if (result === 'accepted') { accepted++; acceptedEventIds.push(telemetryText(event.event_id, 64)) }
    if (result === 'duplicate') duplicateEventIds.push(telemetryText(event.event_id, 64))
  }
  return e.json(202, { accepted: accepted, accepted_event_ids: acceptedEventIds, duplicate_event_ids: duplicateEventIds })
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
  function telemetryNumber(value) { return typeof value === 'number' && isFinite(value) && value >= 0 ? value : 0 }
  function telemetryText(value, max) { return typeof value === 'string' ? value.slice(0, max) : '' }
  function gatewayKeyFingerprint(event) {
    var auth = event.request.header.get('Authorization') || ''; var apiKey = auth.replace(/^Bearer\s+/i, '')
    if (!apiKey) return null
    var hash = $security.sha256(apiKey)
    try { event.app.findFirstRecordByFilter('api_keys', 'key_hash = {:hash}', { hash: hash }); return hash } catch (_) { return null }
  }
  function runFor(app, sessionId, workflow, requestedRunId, owner) {
    var existing = null
    if (requestedRunId) {
      try { existing = app.findRecordById('workflow_runs', requestedRunId) } catch (_) {}
      if (existing && (existing.get('telemetry_ownership_status') === 'ambiguous' || existing.get('api_key_fingerprint') !== owner)) return null
      if (!existing) { try { existing = app.findFirstRecordByFilter('workflow_runs', 'external_run_id = {:run} && api_key_fingerprint = {:owner}', { run: requestedRunId, owner: owner }) } catch (_) {} }
    } else {
      try { existing = app.findFirstRecordByFilter('workflow_runs', 'session_id = {:session} && api_key_fingerprint = {:owner}', { session: sessionId, owner: owner }) } catch (_) {}
    }
    if (existing) return existing
    var run = new Record(app.findCollectionByNameOrId('workflow_runs'))
    run.set('workflow_name', telemetryText(workflow, 100) || 'telemetry'); run.set('status', 'running'); run.set('started_at', new Date().toISOString())
    run.set('session_id', telemetryText(sessionId, 255)); if (requestedRunId) run.set('external_run_id', telemetryText(requestedRunId, 64))
    run.set('api_key_fingerprint', owner); run.set('telemetry_ownership_status', 'bound'); app.save(run); return run
  }
  var fingerprint = gatewayKeyFingerprint(e)
  if (!fingerprint) return e.json(401, { error: 'Invalid API key' })
  var log
  try { log = JSON.parse(toString(e.request.body)) } catch (_) { return e.json(400, { error: 'Invalid JSON body' }) }
  var sessionId = telemetryText(log.run_session_id, 255) || telemetryText(log.thread_id || log.session_id, 255)
  if (!sessionId) return e.json(400, { error: 'run_session_id or thread_id is required' })
  var run = runFor(e.app, sessionId, log.workflow, telemetryText(log.run_id, 255), fingerprint)
  if (!run) return e.json(409, { error: 'Workflow run belongs to another API key' })
  var phase = telemetryText(log.phase, 255); var toolName = telemetryText(log.tool_name, 255)
  if (!phase || !toolName) return e.json(400, { error: 'phase and tool_name are required' })
  var record = new Record(e.app.findCollectionByNameOrId('workflow_logs'))
  record.set('run_id', run.id); record.set('phase', phase); record.set('tool_name', toolName)
  record.set('tool_input', log.tool_input || {}); record.set('tool_output', telemetryText(log.tool_output, 102400))
  record.set('sequence', telemetryNumber(log.sequence)); record.set('duration_ms', telemetryNumber(log.duration_ms)); e.app.save(record)
  if (!record) return e.json(400, { error: 'phase and tool_name are required' })
  return e.json(201, { id: record.id, run_id: run.id })
})

routerAdd('GET', '/api/gateway/runs/{runId}/usage', function (e) {
  function gatewayKeyFingerprint(event) {
    var auth = event.request.header.get('Authorization') || ''; var apiKey = auth.replace(/^Bearer\s+/i, '')
    if (!apiKey) return null
    var hash = $security.sha256(apiKey)
    try { event.app.findFirstRecordByFilter('api_keys', 'key_hash = {:hash}', { hash: hash }); return hash } catch (_) { return null }
  }
  var fingerprint = gatewayKeyFingerprint(e)
  if (!fingerprint) return e.json(401, { error: 'Invalid API key' })
  var runId = e.request.pathValue('runId')
  var run
  try {
    run = e.app.findRecordById('workflow_runs', runId)
    if (run.get('api_key_fingerprint') !== fingerprint) {
      return e.json(404, { error: 'Workflow run not found' })
    }
  } catch (_) {
    try {
      run = e.app.findFirstRecordByFilter(
        'workflow_runs',
        'external_run_id = {:run} && api_key_fingerprint = {:fingerprint}',
        { run: runId, fingerprint: fingerprint },
      )
      runId = run.id
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
