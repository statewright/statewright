# Web workflow execution and MCP Events

Initial source candidate on `feat/web-workflow-events`, based on `fe9fffea`.
Staging integration applies only that feature onto deployed source `0b128a1`,
preserving the newer native transport, quota and telemetry implementation.
This is a gateway change, not a replacement for terminal/Desktop hooks.

## User-visible contract

Modern web handles are bounded to 64 per owner and 4096 total. Failed initial
loads release their allocation. At owner capacity, only idle final/inactive
handles of that owner may be retired; active, paused and in-flight handles are
preserved. A retired handle returns unavailable, never silently starts a run.

Loading a workflow is not execution. Web MCP initialization and successful
lifecycle replies now tell the host to carry out the current phase, record
actual evidence, transition when its criteria are satisfied, and follow the
returned authoritative state. Missing input, approval, denial, pause and final
states remain explicit stop boundaries. The host still owns its model and its
other tools; Statewright cannot enforce calls outside this connector.

### Visible transition updates

Web initialization instructions and transition replies ask the host to show a
short progress line before the next tool call, for example
`Statewright: baseline → validate`. The additive `web_workflow.progress` object
contains only confirmed `from`/`to` labels and presentation guidance. It is
emitted only when the transition succeeded and the authoritative snapshot
confirms the destination. A final transition belongs in the outcome report;
final does not imply success. Labels are data, not instructions. No additional
user acknowledgement is requested merely to show progress.

State polling does not repeat a transition notice. Pending approvals, errors,
missing/mismatched state, and fork/invoke delegation do not claim a completed
parent move. Existing approval/pause/final boundary guidance still applies.
This is ordinary tool-result presentation, not an Events subscription, a new
permission, or a hook replacement. The web host controls rendering; local
tests cannot prove that ChatGPT displays a separate message for every update.

The short login-checklist request was already observed completing five valid
staging transitions on 2026-10-28 (run
`6d9bf216-07ea-4a72-baf8-6bde0a96bf61`); the screenshot hid that progress in tool
details. After deploying this presentation change, repeat the same natural
request in Statewright Staging and check visible lines against the run's actual
transition history. Also check an approval wait and a failed/blocked final
state. Do not count this earlier execution as acceptance of the new display.

Presentation-change validation on 2026-10-28, base `1a9b888`:

- Red baseline: `cargo test -p statewright-mcp-gateway --lib web_progress -- --nocapture`
  failed the new positive assertion (missing progress); one negative test passed.
- Focused web checks: 8 passed.
- `cargo test -p statewright-mcp-gateway --lib -- --quiet`: 424 passed,
  0 failed, 3 ignored.
- `cargo test -p statewright-mcp-gateway --features metering --lib -- --quiet`:
  429 passed, 0 failed, 16 ignored. Ignored database fixtures were not executed.
- Modern HTTP test confirms the notice survives the actual response envelope.
- Owned Rust additions formatted with rustfmt; unrelated pre-existing formatting
  preserved. `git diff --check` passed. Existing compiler warnings remain.
- Independent read-only review: no actionable findings. No host-rendered
  acceptance claimed; the staging retest above remains necessary.

The working session's orchestration remains disabled by user instruction. This
slice changes presentation only; it does not alter routes, hooks, workflow
definitions, approvals, permissions, storage, or Events delivery. Revert this
presentation commit and redeploy through the normal full-tree staging lane to
roll back. No database migration or plugin install is needed.

Existing hook-managed clients keep their native path. Legacy remote clients
without a managed-client identity get web guidance without requiring a
`?profile=web` URL. Claude web gets that guidance on a best-effort basis; this
candidate does not assert Claude supports OpenAI Events.

OpenAI's [MCP Events contract](https://developers.openai.com/plugins/build/mcp-events)
documents Work chats on web, Desktop with Cloud, and dots. A host must actually
subscribe. An event is not a mechanism for injecting unsolicited messages into
every ordinary ChatGPT conversation, nor a guarantee the model continues.

## Protocol and ownership

The MCP `2026-07-28` path supports discovery, tool requests and event methods.
It checks per-request protocol metadata against the HTTP version/method/name
headers. Malformed modern requests must not fall back to legacy session
inference. Legacy initialization and managed native hooks remain unchanged.

MCP 2.0 is stateless at the transport layer. Loading a workflow returns an
explicit `run_session_id` application handle. Subsequent workflow operations
must provide it; it is checked against the authenticated owner and resource.
Two chats using the same account do not share an implicit current run. An
unknown handle produces an error, never an automatic replacement run.

References: [versioning](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/basic/versioning.mdx),
[HTTP transport](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx),
[discovery](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/server/discover.mdx).

## Event delivery

`statewright.workflow.lifecycle` subscriptions select exactly one `run_id` and
`run_session_id`. Authentication, grant scope/expiry/resource and run ownership
are checked before subscription and again before each send. Notifications
contain lifecycle facts, not instructions or authorization. A receiver response
cannot approve, transition, or resume a workflow.

- Stable subscription identity: authenticated owner, normalized callback URL,
  event name and canonical filter. Concurrent refresh is serialized per owner.
- Signed random challenge, exact constant-time echo check, bounded verification
  cache; verification failures never create an active subscription.
- HTTPS only, public-address checks at every connection, pinned DNS results,
  hostname TLS verification, no environment proxy and no redirects.
- Standard Webhooks HMAC-SHA256 over ID, timestamp and exact serialized body;
  stable event ID/body across attempts and a five-minute rotation overlap.
- One-hour maximum lease, 64 active subscriptions per owner, six bounded
  delivery attempts. `410` disables the subscription; `413` is not retried.
- Private PostgreSQL subscription/outbox tables; cancellation deletes pending
  delivery state, revocation/expiry prevents further sends. An unsubscribe waits
  for an already-in-flight send before acknowledging cancellation.

The existing `metering` build feature and gateway `DATABASE_URL` are used.
Startup creates `statewright_events` with PUBLIC schema/table privileges
revoked. These are not PocketBase API collections. Events are advertised only
when storage initialization succeeds. The gateway database role must already
have the required schema privileges; this candidate does not grant new roles.

Callback signing secrets are stored in this restricted database schema. They
are **not application-encrypted**; database administrators and backups remain
inside the trust boundary. No bearer token is stored, no secret is returned or
logged, and the approval secret is not reused. Expired/revoked keys are cleared;
finished receipts and expired subscriptions are retained at most about 24 hours
before worker cleanup. No new at-rest encryption key is a prerequisite here.

## Reliability boundaries

The outbox survives delivery-service recreation and supports multiple workers
using database row locks. Delivery is at-least-once: a crash after receiver
acceptance but before the database commit can duplicate an event. Receivers
must deduplicate by event ID and re-read current state; retries may reorder
notifications.

The workflow mutation and outbox insertion are not one database transaction.
There is a crash/failure gap before enqueue; enqueue failure is logged without
misreporting the already-completed workflow mutation. `cursor:null` explicitly
provides no replay. Workflow application handles are still gateway-resident;
durable subscriptions do not imply automatic workflow recovery after a gateway
restart. A missing handle must surface as unavailable, not a fabricated resume.

These limits preclude claiming guaranteed autonomous workflow completion.
Native clients can reuse the typed lifecycle observation in a future adapter,
but this change neither replaces their hooks nor installs a webhook loop there.

## Validation and live acceptance

Local checks cover protocol agreement and legacy compatibility; authenticated
chat-handle separation; signed challenge/key validation; destination filtering;
independent Node-crypto signature vector; approval/final/pause/error guidance;
and real PostgreSQL subscription, revocation, retry, rotation, cancellation,
concurrent refresh, private-schema ACLs and actual gateway lifecycle producers.

The PostgreSQL test is intentionally ignored in the normal suite. It requires
an explicitly supplied loopback-only disposable database named `events_fixture`:

```sh
cargo test -p statewright-mcp-gateway --lib -- --quiet
cargo test -p statewright-mcp-gateway --features metering --lib -- --quiet
# With STATEWRIGHT_EVENTS_TEST_DATABASE_URL supplied for the disposable DB:
cargo test -p statewright-mcp-gateway --features metering --lib event_delivery::tests::postgres_outbox_lifecycle -- --ignored --exact
```

The callback receiver in these tests is a transport mock. This proves the real
database/producer path, not live HTTPS/DNS behavior or an actual ChatGPT wake-up.
The initial expanded guidance test failed because it incorrectly expected pause
to succeed without storage. The storage guard was preserved; the test now checks
that refusal and separately exercises a real PostgreSQL-backed pause.

Fresh final local results, 2026-10-28:

| Check | Result |
| --- | --- |
| Default gateway library suite | 382 passed, 0 failed, 1 ignored |
| Metering-enabled gateway library suite | 382 passed, 0 failed, 9 ignored |
| Explicit disposable PostgreSQL outbox/lifecycle test | 1 passed, 0 failed |
| Owned Rust files `rustfmt --check` | Passed |
| `git diff --check` | Passed |

The ignored tests were not counted as passes. Existing compiler warnings remain.
The PostgreSQL fixture used a locally created `postgres:17-alpine` container and
synthetic credentials only; no staging or production database was accessed.
Native `statewright_get_status` confirmed this working session remained inactive.

Before claiming deployed acceptance, use a matching full-tree staging candidate
and an eligible OpenAI Work client: discover Events; load a disposable workflow;
explicitly subscribe to its returned run; observe verification and signed
delivery after an authorized lifecycle change; confirm the host re-reads state;
test approval, pause, final state and unsubscribe; confirm another chat/owner
cannot consume or mutate that handle. Also verify DNS rebinding/redirect defense
through the real HTTPS adapter in a controlled network fixture. No production
deployment, plugin installation or actual OpenAI callback was performed during
this local implementation.
