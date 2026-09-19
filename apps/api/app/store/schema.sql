CREATE TABLE IF NOT EXISTS crisis_schema_version (
    version integer PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS crisis_world (
    incident_id text PRIMARY KEY,
    version bigint NOT NULL,
    snapshot jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS crisis_observations (
    observation_id text PRIMARY KEY,
    incident_id text NOT NULL,
    received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    body jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS crisis_observations_incident
    ON crisis_observations (incident_id, received_at, observation_id);
CREATE TABLE IF NOT EXISTS crisis_receipts (
    observation_id text PRIMARY KEY REFERENCES crisis_observations(observation_id),
    incident_id text NOT NULL,
    status text NOT NULL CHECK (status IN ('applied', 'ignored', 'invalid')),
    reason text NOT NULL,
    processed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS crisis_assignments (
    incident_id text NOT NULL REFERENCES crisis_world(incident_id),
    resource_id text NOT NULL,
    task_id text,
    status text NOT NULL,
    PRIMARY KEY (incident_id, resource_id)
);
CREATE TABLE IF NOT EXISTS crisis_commands (
    command_id text PRIMARY KEY,
    incident_id text NOT NULL REFERENCES crisis_world(incident_id),
    status text NOT NULL,
    body jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS crisis_journal (
    incident_id text NOT NULL REFERENCES crisis_world(incident_id),
    kind text NOT NULL,
    object_id text NOT NULL,
    body jsonb NOT NULL,
    PRIMARY KEY (incident_id, kind, object_id)
);
INSERT INTO crisis_schema_version(version) VALUES (1) ON CONFLICT DO NOTHING;
