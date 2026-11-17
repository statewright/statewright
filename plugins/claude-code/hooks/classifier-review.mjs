// Human-facing projection shared in semantics with the executor review card.
// Only masked, bounded text reaches the native choice UI.
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

const DURATION_LABELS = Object.freeze({
  once: 'Allow once',
  '2h': 'Allow for 2 hours',
  '4h': 'Allow for 4 hours',
  '8h': 'Allow for 8 hours',
  always: 'Always',
});
const DURATION_ORDER = Object.keys(DURATION_LABELS);
const REASONS = Object.freeze({
  semantic_authorization_disabled: "The built-in checks did not prove this request's effects. Semantic assessments cannot authorize commands here, so this request needs your review.",
  incomplete_structural_evidence: 'The command structure or a referenced script could not be fully verified. Review the command and its dependencies.',
  semantic_vector_unavailable: 'The semantic assessor returned no usable judgment for this invocation.',
  semantic_assessment_incomplete: 'The semantic assessment did not complete successfully.',
  semantic_threshold_not_met: 'The semantic assessment did not establish a sufficiently safe effect for this invocation.',
  external_effect_unresolved: 'The command reaches an external service, but its effects could not be determined.',
});

export function classifierReviewChoices(context) {
  const memory = context?.approval_memory;
  const permitted = Array.isArray(memory?.allowed_durations)
    ? DURATION_ORDER.filter(duration => memory.allowed_durations.includes(duration)) : ['once'];
  const durations = memory?.reusable === true ? permitted : ['once'];
  if (!durations.length) durations.push('once');
  const defaultDuration = durations.includes(memory?.approve_for) ? memory.approve_for : 'once';
  const ordered = [defaultDuration, ...durations.filter(duration => duration !== defaultDuration)];
  return { defaultDuration, durations, options: [...ordered.map(duration => DURATION_LABELS[duration]), 'Deny'] };
}

export function classifierReviewDuration(answer, choices) {
  if (typeof answer !== 'string' || !choices?.options?.includes(answer)) return null;
  const duration = DURATION_ORDER.find(key => DURATION_LABELS[key] === answer);
  return choices.durations.includes(duration) ? duration : null;
}

export function classifierReviewMessage(decision, toolName, toolInput, defaultDuration) {
  const display = approvalDisplayContext({ tool_name: toolName, tool_input: toolInput });
  const risk = decision?.risk_assessment;
  const basis = risk?.final_denial_basis ?? risk?.resolution_basis;
  const lines = ['Statewright approval', `Tool: ${display?.tool ?? 'unavailable'}`];
  if (display?.command) lines.push(`Command: ${display.command}`);
  if (display?.details) lines.push(`Request: ${JSON.stringify(display.details, null, 2)}`);
  if (display?.cwd) lines.push(`Working directory: ${display.cwd}`);
  lines.push('', `Why review: ${REASONS[basis] ?? 'The request has an unresolved effect.'}`);
  lines.push(s1ClassificationDisplay(risk));
  lines.push('A timed approval skips Statewright review only for this exact command while its policy and any dependencies Statewright captured remain unchanged. Claude’s own permission prompt may still follow.');
  lines.push('Statewright may not detect changes to executable contents it did not capture. Always lasts until you revoke it or the bound command, captured dependencies, or policy change.');
  lines.push(`Default choice: ${DURATION_LABELS[defaultDuration] ?? DURATION_LABELS.once}.`);
  return lines.join('\n');
}
