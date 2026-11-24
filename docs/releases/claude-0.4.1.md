# Statewright for Claude Code 0.4.1

## Fixed

- **Claude Code 2.1.331 hook compatibility: supported mod API grammar.** The
  native hook now uses direct session and store API calls and top-level Stop
  helpers. Conversation-scoped Stop fallback, grant revocation, and approval
  gate behavior are preserved.

## Update

Run `claude plugin update statewright@statewright`, then reload the conversation
with `/reload-plugins`. Claude Code 2.1.295 remains the minimum supported
engine. This patch adds no new workflow capability.
