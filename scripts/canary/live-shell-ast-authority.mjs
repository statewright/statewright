#!/usr/bin/env node

import { randomBytes } from 'node:crypto'

const appUrl = process.env.STATEWRIGHT_APP_URL?.replace(/\/$/, '')
const mcpUrl = process.env.STATEWRIGHT_MCP_URL?.replace(/\/$/, '')

if (!appUrl || !mcpUrl) {
  console.error('STATEWRIGHT_APP_URL and STATEWRIGHT_MCP_URL are required')
  process.exit(2)
}

const marker = `${Date.now()}-${randomBytes(6).toString('hex')}`
const email = `shell-ast-canary-${marker}@statewright.dev`
const password = `ShellAst-${randomBytes(18).toString('base64url')}-9!`
const workflowName = `classifier-canary-${marker}`
let userId
let userToken
let keyId
let apiKey
let sessionId
let rpcId = 0

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(20_000)
  })
  const text = await response.text()
  let body = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  return { response, body }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function boundedFailure(body) {
  if (!body || typeof body !== 'object') return 'no structured error'
  const code = typeof body.error === 'string' ? body.error : null
  const message = typeof body.message === 'string' ? body.message : null
  const fields = body.data && typeof body.data === 'object'
    ? Object.entries(body.data)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, detail]) => `${name}:${detail?.code || detail?.message || 'invalid'}`)
      .join(',')
    : null
  return [code && `error=${code}`, message && `message=${message}`, fields && `fields=${fields}`]
    .filter(Boolean)
    .join(' ') || 'no bounded error fields'
}

function parseMcpBody(response, text) {
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('text/event-stream')) {
    const data = text
      .split('\n')
      .find((line) => line.startsWith('data:'))
      ?.slice(5)
      .trim()
    assert(data, 'MCP response did not contain an SSE data event')
    return JSON.parse(data)
  }
  return text ? JSON.parse(text) : null
}

async function rpc(method, params, { notification = false } = {}) {
  const headers = {
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'X-Statewright-Client-Id': `shell-ast-canary-${marker}`
  }
  if (sessionId) headers['Mcp-Session-Id'] = sessionId
  const payload = { jsonrpc: '2.0', method, params }
  if (!notification) payload.id = ++rpcId
  const response = await fetch(mcpUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000)
  })
  const negotiatedSession = response.headers.get('mcp-session-id')
  if (negotiatedSession) sessionId = negotiatedSession
  const text = await response.text()
  assert(response.ok, `${method} returned HTTP ${response.status}`)
  if (notification) return null
  const envelope = parseMcpBody(response, text)
  assert(!envelope?.error, `${method} returned JSON-RPC error ${JSON.stringify(envelope.error)}`)
  return envelope?.result
}

async function tool(name, args = {}) {
  const result = await rpc('tools/call', { name, arguments: args })
  assert(!result?.isError, `${name} returned a tool error`)
  const text = result?.content?.find((item) => item.type === 'text')?.text
  assert(text, `${name} returned no text result`)
  return JSON.parse(text)
}

const cases = [
  {
    name: 'plain_git_status',
    command: 'git status --short',
    decision: 'allow',
    source: 'shell_ast',
    risk: 'Low',
    exposure: 'Local'
  },
  {
    name: 'compound_read',
    command: 'if git rev-parse HEAD; then tmux capture-pane -p -t %36 | tail -80; fi',
    decision: 'allow',
    source: 'shell_ast',
    risk: 'Low',
    exposure: 'Local'
  },
  {
    name: 'read_only_loop',
    command: 'for reference in HEAD main; do git rev-parse "$reference"; done',
    decision: 'allow',
    source: 'shell_ast',
    risk: 'Low',
    exposure: 'Local'
  },
  {
    name: 'nested_command_substitution',
    command: 'printf \'%s\\n\' "$(git push origin HEAD)"',
    decision: 'deny',
    source: 'shell_ast',
    risk: 'High',
    exposure: 'External'
  },
  {
    name: 'shell_heredoc',
    command: "bash <<'EOF'\ngit push origin HEAD\nEOF",
    decision: 'deny',
    source: 'shell_ast',
    risk: 'High',
    exposure: 'External'
  },
  {
    name: 'process_substitution',
    command: 'cat <(git push origin HEAD)',
    decision: 'deny',
    source: 'shell_ast',
    risk: 'High',
    exposure: 'External'
  },
  {
    name: 'logical_or_push',
    command: 'git rev-parse HEAD || git push origin HEAD',
    decision: 'deny',
    source: 'shell_ast',
    risk: 'High',
    exposure: 'External'
  },
  {
    name: 'conditional_recursive_delete',
    command: 'if test -d target; then rm -rf target; fi',
    decision: 'deny',
    source: 'shell_ast',
    risk: 'Critical',
    exposure: 'Local'
  },
  {
    name: 'data_heredoc_redirect',
    command: "cat > artifact <<'EOF'\ngit push origin HEAD\nEOF",
    decision: 'allow',
    source: 'shell_ast',
    risk: 'Moderate',
    exposure: 'Local'
  },
  {
    name: 'mkdir_local_write',
    command: 'mkdir -p docs/plans',
    decision: 'allow',
    source: 'shell_ast',
    risk: 'Moderate',
    exposure: 'Local'
  },
  {
    name: 'malformed_shell',
    command: 'if git status --short; then',
    decision: 'deny',
    source: 'shell',
    risk: 'Moderate',
    exposure: 'Unknown'
  },
  {
    name: 'opaque_executable',
    command: 'private-runner --opaque-value',
    decision: 'deny',
    source: 'shell_ast',
    risk: 'Moderate',
    exposure: 'Unknown'
  }
]

const results = []
const nativeAliasResults = []
let failure

try {
  const created = await jsonRequest(`${appUrl}/api/collections/users/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, passwordConfirm: password })
  })
  assert(created.response.ok, `user creation returned HTTP ${created.response.status}`)
  userId = created.body.id

  const authenticated = await jsonRequest(
    `${appUrl}/api/collections/users/auth-with-password`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: email, password })
    }
  )
  assert(authenticated.response.ok, `authentication returned HTTP ${authenticated.response.status}`)
  userToken = authenticated.body.token

  const workflow = await jsonRequest(`${appUrl}/api/collections/workflows/records`, {
    method: 'POST',
    headers: { Authorization: userToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      owner: userId,
      name: workflowName,
      active: true,
      definition: {
        id: workflowName,
        initial: 'implement',
        context: { tool_policy_mode: 'denylist_heuristic_v1' },
        meta: { classifier_policy: { risk_tolerance: 'assessed_moderate_local' } },
        states: {
          implement: { disallowed_tools: [], on: { DONE: 'done' } },
          done: { type: 'final' }
        },
        guards: {}
      }
    })
  })
  assert(workflow.response.ok, `workflow creation returned HTTP ${workflow.response.status}: ${boundedFailure(workflow.body)}`)

  const issued = await jsonRequest(`${appUrl}/api/oauth/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: 'statewright-codex', scope: 'mcp' })
  })
  assert(issued.response.ok, `device code issuance returned HTTP ${issued.response.status}: ${boundedFailure(issued.body)}`)

  const approved = await jsonRequest(`${appUrl}/api/oauth/device/authorization`, {
    method: 'POST',
    headers: { Authorization: userToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_code: issued.body.user_code, decision: 'approve' })
  })
  assert(approved.response.ok, `device approval returned HTTP ${approved.response.status}: ${boundedFailure(approved.body)}`)
  assert(approved.body?.status === 'approved', `device approval returned ${approved.body?.status || 'no status'}`)

  const exchanged = await jsonRequest(`${appUrl}/api/oauth/device/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: 'statewright-codex',
      device_code: issued.body.device_code
    })
  })
  assert(exchanged.response.ok, `device token exchange returned HTTP ${exchanged.response.status}: ${boundedFailure(exchanged.body)}`)
  apiKey = exchanged.body.access_token
  assert(/^sw_live_[A-Za-z0-9_-]{64}$/.test(apiKey), 'device token exchange returned an invalid access token')

  const listed = await jsonRequest(`${appUrl}/api/keys`, {
    headers: { Authorization: userToken }
  })
  assert(listed.response.ok, `key listing returned HTTP ${listed.response.status}`)
  keyId = listed.body?.keys?.find((entry) => entry.prefix === apiKey.substring(0, 12))?.id
  assert(keyId, 'OAuth-created API key was not visible to its owner')

  await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'shell-ast-authority-canary', version: '1' }
  })
  await rpc('notifications/initialized', {}, { notification: true })
  await tool('statewright_load_workflow', { name: workflowName })

  for (const entry of cases) {
    const result = await tool('statewright_adapter_pre_tool', {
      tool_name: 'exec_command',
      tool_input: { cmd: entry.command }
    })
    const risk = result.risk_assessment || {}
    assert(result.decision === entry.decision, `${entry.name}: expected ${entry.decision}, got ${result.decision}`)
    assert(risk.deterministic_source === entry.source, `${entry.name}: expected source ${entry.source}, got ${risk.deterministic_source}`)
    assert(risk.deterministic_risk === entry.risk, `${entry.name}: expected risk ${entry.risk}, got ${risk.deterministic_risk}`)
    assert(risk.deterministic_exposure === entry.exposure, `${entry.name}: expected exposure ${entry.exposure}, got ${risk.deterministic_exposure}`)
    assert(risk.semantic_status === 'Assessed', `${entry.name}: expected semantic status Assessed, got ${risk.semantic_status}`)
    assert(typeof risk.resolution_basis === 'string', `${entry.name}: missing resolution_basis`)
    assert(typeof risk.required_authority === 'string', `${entry.name}: missing required_authority`)
    if (entry.decision === 'deny') {
      assert(typeof risk.final_denial_basis === 'string', `${entry.name}: missing final_denial_basis`)
    }
    assert(
      risk.equivalent_retry_allowed === (entry.decision === 'allow'),
      `${entry.name}: retry guidance did not match the decision`
    )
    results.push({
      name: entry.name,
      decision: result.decision,
      source: risk.deterministic_source,
      risk: risk.deterministic_risk,
      exposure: risk.deterministic_exposure,
      semantic_status: risk.semantic_status
    })
  }

  for (const alias of [
    'Write',
    'write',
    'Edit',
    'edit',
    'MultiEdit',
    'multiedit',
    'apply_patch',
    'functions.apply_patch',
    'StrReplace',
    'str_replace'
  ]) {
    const result = await tool('statewright_adapter_pre_tool', {
      tool_name: alias,
      tool_input: { path: 'classifier-family-canary', patch: 'classifier-family-canary' }
    })
    const risk = result.risk_assessment || {}
    assert(result.decision === 'allow', `${alias}: expected allow, got ${result.decision}`)
    assert(risk.deterministic_source === 'native_write', `${alias}: expected native_write, got ${risk.deterministic_source}`)
    assert(risk.deterministic_risk === 'Moderate', `${alias}: expected Moderate, got ${risk.deterministic_risk}`)
    assert(risk.deterministic_exposure === 'Local', `${alias}: expected Local, got ${risk.deterministic_exposure}`)
    assert(risk.resolved_effect === 'local_write', `${alias}: expected local_write, got ${risk.resolved_effect}`)
    nativeAliasResults.push({ alias, decision: result.decision, source: risk.deterministic_source })
  }
} catch (error) {
  failure = error
} finally {
  if (keyId && userToken) {
    const revoked = await jsonRequest(`${appUrl}/api/keys/${keyId}`, {
      method: 'DELETE',
      headers: { Authorization: userToken }
    }).catch(() => null)
    if (!revoked?.response.ok && !failure) {
      failure = new Error(`key cleanup returned HTTP ${revoked?.response.status ?? 'unavailable'}`)
    }
  }
  if (userId && userToken) {
    const deleted = await jsonRequest(`${appUrl}/api/collections/users/records/${userId}`, {
      method: 'DELETE',
      headers: { Authorization: userToken }
    }).catch(() => null)
    if (deleted?.response.status !== 204 && !failure) {
      failure = new Error(`user cleanup returned HTTP ${deleted?.response.status ?? 'unavailable'}`)
    }
  }
}

if (failure) {
  console.error(`shell AST authority canary failed: ${failure.message}`)
  process.exit(1)
}

console.log(
  JSON.stringify({
    status: 'pass',
    credential_path: 'oauth_device_grant',
    app_url: appUrl,
    mcp_url: mcpUrl,
    cases: results,
    native_aliases: nativeAliasResults,
    cleanup: { api_key_revoked: true, user_deleted: true }
  })
)
