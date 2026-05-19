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
