ALTER TABLE work_claims ADD COLUMN release_reason TEXT;
ALTER TABLE decisions ADD COLUMN round_deadline_at TIMESTAMPTZ;
ALTER TABLE decisions ADD COLUMN deferred_reason TEXT;
UPDATE decisions SET round_deadline_at=now()+interval '10 minutes' WHERE status='negotiating';
CREATE TABLE session_runtimes (
 session_id UUID PRIMARY KEY REFERENCES sessions(id), repo TEXT NOT NULL, project_id UUID NOT NULL REFERENCES projects(id),
 instance_id UUID NOT NULL, epoch INT NOT NULL DEFAULT 1 CHECK(epoch>0), version INT NOT NULL DEFAULT 1,
 state TEXT NOT NULL CHECK(state IN ('waiting','running','stopped','error','budget_exhausted')),
 heartbeat_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL, missing_notified BOOLEAN NOT NULL DEFAULT false,
 capabilities JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX runtimes_repo_project_idx ON session_runtimes(repo,project_id);
CREATE TABLE coordination_events (
 id UUID PRIMARY KEY REFERENCES domain_events(id), repo TEXT NOT NULL, project_id UUID NOT NULL REFERENCES projects(id),
 action TEXT NOT NULL, aggregate_id UUID NOT NULL, entity_version INT, payload JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL, priority INT NOT NULL DEFAULT 2
);
CREATE TABLE event_deliveries (
 id UUID PRIMARY KEY, repo TEXT NOT NULL, event_id UUID NOT NULL REFERENCES coordination_events(id),
 session_id UUID NOT NULL REFERENCES sessions(id), created_at TIMESTAMPTZ NOT NULL,
 acked_at TIMESTAMPTZ, outcome TEXT, observed_version INT,
 UNIQUE(event_id,session_id)
);
CREATE INDEX deliveries_pending_idx ON event_deliveries(repo,session_id,created_at,id) WHERE acked_at IS NULL;
