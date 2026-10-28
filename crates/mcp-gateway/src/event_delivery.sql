-- Internal gateway tables, intentionally NOT registered as PocketBase collections.
-- Database administrators retain access; do not claim application-level encryption.
CREATE SCHEMA IF NOT EXISTS statewright_events;
REVOKE ALL ON SCHEMA statewright_events FROM PUBLIC;
CREATE TABLE IF NOT EXISTS statewright_events.subscriptions (
    id text PRIMARY KEY,
    owner_id text NOT NULL,
    key_hash text NOT NULL,
    resource text NOT NULL,
    run_id text NOT NULL,
    run_session_id text NOT NULL,
    callback_url text NOT NULL,
    secret text NOT NULL,
    previous_secret text,
    rotation_until timestamptz,
    verified_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS statewright_events.deliveries (
    subscription_id text NOT NULL REFERENCES statewright_events.subscriptions(id) ON DELETE CASCADE,
    event_id text NOT NULL,
    body text NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed','cancelled')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (subscription_id, event_id)
);
CREATE INDEX IF NOT EXISTS event_pending ON statewright_events.deliveries(next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS event_run ON statewright_events.subscriptions(owner_id,run_id,run_session_id);
REVOKE ALL ON ALL TABLES IN SCHEMA statewright_events FROM PUBLIC;
