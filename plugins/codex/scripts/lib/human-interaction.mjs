import { randomUUID } from "node:crypto";

const S1_FIELDS = [["read_only", "read-only"], ["may_write", "write"],
  ["reversible", "reversible"], ["destructive", "destructive"],
  ["irreversible", "irreversible"], ["external_or_account_effect", "external"]];
const S1_STATUSES = new Set(["Disabled", "Queued", "Unavailable", "Timeout", "Malformed", "QueueFull", "Assessed", "ShadowOnly", "NotRequired"]);

// This is presentation data only: do not infer authority from a model score.
export function s1Classification(receipt) {
  const status = S1_STATUSES.has(receipt?.semantic_status) ? receipt.semantic_status : null;
  const raw = receipt?.semantic_vector;
  const vector = {};
  if ((status === "Assessed" || status === "ShadowOnly") && raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key] of S1_FIELDS) {
      if (typeof raw[key] === "number" && Number.isFinite(raw[key]) && raw[key] >= 0 && raw[key] <= 1) vector[key] = raw[key];
    }
  }
  return {semantic_status: status, semantic_vector: Object.keys(vector).length ? vector : null};
}

export function s1ClassificationDisplay(receipt) {
  const {semantic_status: status, semantic_vector: vector} = s1Classification(receipt);
  if (!vector) return `S1 classification: ${status ? status.toLowerCase() : "unavailable"}; no predictions available.`;
  const scores = S1_FIELDS.filter(([key]) => Object.hasOwn(vector, key))
    .map(([key, label]) => `${label} ${Math.round(vector[key] * 100)}%`);
  return `S1 classification: ${scores.join(", ")}.${status === "ShadowOnly" ? " Evaluation only." : ""}`;
}

function isCredentialKey(key) {
  return /(?:authorization|(?:api|access|private|secret)key|password|passwd|passphrase|secret|(?:access|refresh|session|id|proxy)?token|credentials?|cookie)$/.test(String(key).replace(/[^a-z0-9]/gi, '').toLowerCase())
}

// Lex words as data, preserving source spans. Never run a shell or expand its
// variables/substitutions. Escaped spaces and concatenated quoted segments are
// part of the same argument, so masking cannot expose a password suffix.
function maskCommandCredentials(text, depth) {
  depth = depth || 0
  if (depth > 6) return '[truncated]'
  var i = 0, active = false, shell = false, expected = null, edits = []
  function header(value) {
    var colon = value.indexOf(':')
    return colon >= 0 && isCredentialKey(value.slice(0, colon))
      ? JSON.stringify(value.slice(0, colon) + ': [redacted]') : null
  }
  while (i < text.length) {
    var ch = text.charAt(i)
    if (/[;|&\r\n]/.test(ch)) { active = false; shell = false; expected = null; i++; continue }
    if (/\s/.test(ch)) { i++; continue }
    var start = i, word = '', quote = null
    while (i < text.length) {
      ch = text.charAt(i)
      if (quote) {
        if (ch === quote) { quote = null; i++; continue }
        if (ch === '\\' && quote === '"' && i + 1 < text.length) {
          word += text.charAt(i + 1); i += 2; continue
        }
        word += ch; i++; continue
      }
      if (ch === '"' || ch === "'") { quote = ch; i++; continue }
      if (ch === '\\' && i + 1 < text.length) {
        var next = text.charAt(i + 1)
        if (next !== '\n' && next !== '\r') word += next
        i += 2; continue
      }
      if (/[\s;|&]/.test(ch)) break
      word += ch; i++
    }
    if (expected) {
      var replacement = expected === 'header' ? header(word) : expected === 'secret' ? '[redacted]' :
        expected === 'script' ? JSON.stringify(maskCredentialText(word, depth + 1)) : null
      if (replacement !== null) edits.push({start:start, end:i, value:replacement})
      expected = null; continue
    }
    if (/^(?:.*[\\/])?curl(?:\.exe)?$/i.test(word)) { active = true; shell = false; continue }
    if (/^(?:.*[\\/])?(?:bash|sh|zsh|dash|ksh|fish|cmd|powershell|pwsh)(?:\.exe)?$/i.test(word)) {
      shell = true; active = false; continue
    }
    if (shell && /^(?:-[a-z]*c[a-z]*|--command|-command|\/c)$/i.test(word)) { expected = 'script'; continue }
    var assignment = word.indexOf('=')
    if (assignment > 0 && isCredentialKey(word.slice(0, assignment))) {
      edits.push({start:start, end:i, value:word.slice(0, assignment + 1) + '[redacted]'}); continue
    }
    if (/^--?/.test(word) && !/^--no[-_]/i.test(word) && isCredentialKey(word.replace(/^--?/, ''))) {
      expected = 'secret'; continue
    }
    if (!active) continue
    if (word === '--') { active = false; continue }
    if (word.slice(0, 2) === '--') {
      var equals = word.indexOf('='), option = equals < 0 ? word : word.slice(0, equals)
      var kind = ['--user', '--proxy-user', '--cookie', '--oauth2-bearer'].indexOf(option) >= 0
        ? 'secret' : ['--header', '--proxy-header'].indexOf(option) >= 0 ? 'header' : null
      if (!kind) continue
      if (equals < 0) expected = kind
      else {
        var projected = kind === 'header' ? header(word.slice(equals + 1)) : '[redacted]'
        if (projected !== null) edits.push({start:start, end:i, value:option + '=' + projected})
      }
      continue
    }
    if (word.charAt(0) !== '-') continue
    for (var j = 1; j < word.length; j++) {
      var flag = word.charAt(j), type = /[uUb]/.test(flag) ? 'secret' : flag === 'H' ? 'header' : null
      if (type) {
        if (j + 1 === word.length) expected = type
        else {
          var value = type === 'header' ? header(word.slice(j + 1)) : '[redacted]'
          if (value !== null) edits.push({start:start, end:i, value:word.slice(0, j + 1) + value})
        }
        break
      }
      // Stop at an option taking an ordinary value. Its value is not a bundle
      // of curl flags (for example, -ooutput must not be treated as -u).
      if ('AcCdDeEFKmoPQrTwxXyYz'.indexOf(flag) >= 0) { if (j + 1 === word.length) expected = 'ordinary'; break }
      if ('aBfgGiIjJklLMnNOpqRsSvV#'.indexOf(flag) < 0) break
    }
  }
  for (var k = edits.length - 1; k >= 0; k--) text = text.slice(0, edits[k].start) + edits[k].value + text.slice(edits[k].end)
  return text
}

function maskCredentialText(value, depth) {
  return maskCommandCredentials(value, depth)
    .replace(/((?:"|')([a-z0-9_-]+)(?:"|')\s*:\s*)(?:"(?:\\[\s\S]|[^"\\])*"|'[^']*'|[^\s,}\]]+)/gi, function (match, prefix, key) {
      return isCredentialKey(key) ? prefix + '"[redacted]"' : match
    })
    .replace(/^([ \t]*([a-z0-9_-]+)[ \t]*:[ \t]*)([^\r\n]*)/gim, function (match, prefix, key) {
      return isCredentialKey(key) ? prefix + '[redacted]' : match
    })
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[redacted]')
    .replace(/\bsw_(?:live|test)_[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/([?&])([^=&#\s"']+)=([^&#\s"']*)/g, function (match, separator, key) {
      var decoded = key
      try { decoded = decodeURIComponent(key) } catch (_) {}
      return isCredentialKey(decoded) ? separator + key + '=[redacted]' : match
    })
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
}

export function interactionText(value, maximum = 4096, depth = 0) {
  if (typeof value !== "string") return null;
  if (depth > 6) return "[truncated]";
  if (/^\s*[\[{]/.test(value)) {
    try {
      const parsed = JSON.parse(value);
      const projected = JSON.stringify(interactionValue(parsed, depth + 1));
      return projected.length > maximum ? projected.slice(0, maximum) + " [truncated]" : projected;
    } catch { /* Non-JSON commands keep the ordinary text projection. */ }
  }
  const masked = maskCredentialText(value);
  return masked.length > maximum ? masked.slice(0, maximum) + " [truncated]" : masked;
}

export function interactionValue(value, depth = 0) {
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") return interactionText(value, 4096, depth);
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) {
    const output = value.slice(0, 32).map(item => interactionValue(item, depth + 1));
    if (value.length > 32) {
      const prior = value.length === 33 ? value[32]?._statewright_omitted_items : null;
      output.push({_statewright_omitted_items: Number.isSafeInteger(prior) && prior > 0 ? prior : value.length - 32});
    }
    return output;
  }
  if (typeof value !== "object") return null;
  return Object.fromEntries(Object.entries(value).slice(0, 64).map(([key, item]) => [
    key, isCredentialKey(key)
      ? "[redacted]" : interactionValue(item, depth + 1),
  ]));
}

export function approvalDisplayContext(value) {
  const input = value?.tool_input ?? {};
  const display = value?.display_context ?? {};
  const tool = interactionText(value?.tool_name ?? display.tool, 128);
  const command = interactionText(input.command ?? input.cmd ?? display.command, 8192);
  const cwd = interactionText(input.workdir ?? input.cwd ?? display.cwd, 1024);
  const details = {};
  // Display actual requested actions, not a tool-name-only consent card.
  // This projection is for human review/logging; it never grants authority.
  const keys = ["search_query", "image_query", "open", "click", "find", "screenshot",
    "finance", "weather", "sports", "time", "query", "q", "url", "method", "operation", "action"];
  for (const key of keys) {
    if (Object.hasOwn(input, key)) details[key] = interactionValue(input[key]);
    else if (display.details && Object.hasOwn(display.details, key)) details[key] = interactionValue(display.details[key]);
  }
  // MCP tools have provider-specific argument names. Show their bounded,
  // credential-masked arguments so approval is meaningful for any provider.
  if (tool?.startsWith("mcp__")) {
    const generic = Object.fromEntries(Object.entries(input).filter(([key]) => key !== "workdir" && key !== "cwd"));
    const source = Object.keys(generic).length ? generic : display.details;
    if (source && typeof source === "object" && !Array.isArray(source)) Object.assign(details, interactionValue(source));
  }
  const context = command || tool ? { tool, command, cwd } : null;
  if (context && Object.keys(details).length) context.details = details;
  return context;
}

export class HumanInteractionRecorder {
  constructor(record) { this.record = record; this.pending = new Map(); this.completed = new Map(); this.executions = new Map(); }
  emit(fields) {
    const event = {schema:"statewright/human-interaction/v1", ...fields};
    void Promise.resolve().then(() => this.record(event)).catch(() => {});
  }
  request(message, {runId} = {}) {
    if (message?.id === undefined || typeof message.method !== "string"
        || !/(?:\/requestApproval|\/requestUserInput|elicitation\/request)$/.test(message.method)) return;
    const key = JSON.stringify([typeof message.id, message.id]);
    if (this.pending.has(key)) return;
    const item = {interaction_id:randomUUID(), request_id:String(message.id),
      thread_id:message.params?.threadId ?? message.params?.thread_id ?? null, method:message.method,
      ...(runId ? {run_id:runId} : {}),
      dialog:interactionValue(message.params), native_item_id:message.params?.itemId ?? null};
    this.pending.set(key, item);
    this.emit({...item, stage:"requested"});
  }
  response(message) {
    if (message?.method || message?.id === undefined) return;
    const key = JSON.stringify([typeof message.id, message.id]);
    const item = this.pending.get(key);
    if (!item) return;
    this.pending.delete(key);
    if (this.completed.size >= 1024) this.completed.delete(this.completed.keys().next().value);
    this.completed.set(key, item);
    if (item.native_item_id && /commandExecution/.test(item.method)) {
      if (this.executions.size >= 1024) this.executions.delete(this.executions.keys().next().value);
      this.executions.set(JSON.stringify([item.thread_id, item.native_item_id]), item);
    }
    this.emit({...item, stage:message.error ? "failed" : "responded",
      result:interactionValue(message.error ?? message.result), actor_source:"native_client_reply"});
  }
  resolve(requestId, result) {
    const key = JSON.stringify([typeof requestId, requestId]);
    const item = this.completed.get(key) ?? this.pending.get(key);
    this.pending.delete(key);
    this.completed.delete(key);
    if (item) this.emit({...item, stage:"resolved", result:interactionValue(result)});
  }
  recordClassifierApproval(event) {
    const grant = event.grant_id ? {
      grant_id:event.grant_id, duration:event.duration, expires_at:event.expires_at,
    } : {};
    if (event.type === "classifier_approval_memory_reused") {
      this.emit({stage:"approval_reused", method:"statewright/classifierApproval",
        interaction_id:event.grant_id, request_id:event.invocation_fingerprint,
        thread_id:event.threadId, run_id:event.run_id,
        result:{action:"reuse", ...grant, invocation_fingerprint:event.invocation_fingerprint}});
    } else if (event.approval_request_id) {
      const granted = event.type === "classifier_human_approval_granted";
      this.resolve(event.approval_request_id, {
        action:granted ? "allow_once" : "deny",
        ...(granted ? {approval_scope:event.grant_id ? "remembered" : "once"} : {}),
        ...grant, reason:event.reason, invocation_fingerprint:event.invocation_fingerprint,
      });
    }
  }
  observeExecution(notification) {
    if (notification?.method !== "item/completed") return;
    const params = notification.params;
    const key = JSON.stringify([params?.threadId, params?.item?.id]);
    const item = this.executions.get(key);
    if (!item) return;
    this.executions.delete(key);
    this.emit({...item, stage:"execution_completed", result:interactionValue({
      status:params.item.status, exit_code:params.item.exitCode,
      output:params.item.aggregatedOutput, duration_ms:params.item.durationMs})});
  }
  close(reason = "connection_closed") {
    for (const item of this.pending.values()) this.emit({...item, stage:"interrupted", result:{reason}});
    this.pending.clear();
    this.completed.clear();
    this.executions.clear();
  }
}
