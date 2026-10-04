CREATE TABLE goals (
 id UUID PRIMARY KEY, repo TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 title TEXT NOT NULL, objective TEXT NOT NULL, acceptance JSONB NOT NULL, created_by TEXT NOT NULL
);
CREATE TABLE sessions (
 id UUID PRIMARY KEY, repo TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 member TEXT NOT NULL, agent_type TEXT NOT NULL, last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE changes (
 id UUID PRIMARY KEY, repo TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 goal_id UUID NOT NULL REFERENCES goals(id), title TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('probable','implementing','verifying','completed','abandoned')),
 created_by TEXT NOT NULL, version INT NOT NULL DEFAULT 1 CHECK(version > 0),
 likely_scope JSONB NOT NULL, error_fingerprints JSONB NOT NULL, branch TEXT,
 summary TEXT NOT NULL, verification JSONB, pr_url TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX changes_repo_idx ON changes(repo, updated_at);
CREATE TABLE change_sessions (
 change_id UUID NOT NULL REFERENCES changes(id), session_id UUID NOT NULL REFERENCES sessions(id),
 PRIMARY KEY(change_id, session_id)
);
CREATE TABLE findings (
 id UUID PRIMARY KEY, repo TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 change_id UUID NOT NULL REFERENCES changes(id), session_id UUID NOT NULL REFERENCES sessions(id),
 kind TEXT NOT NULL CHECK(kind IN ('observation','hypothesis','root_cause','constraint','test_result')),
 content TEXT NOT NULL, confidence JSONB NOT NULL
);
CREATE INDEX findings_change_idx ON findings(change_id);
CREATE TABLE decisions (
 id UUID PRIMARY KEY, repo TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 question TEXT NOT NULL, context TEXT NOT NULL, category TEXT NOT NULL, urgency TEXT NOT NULL CHECK(urgency IN ('blocking','normal','low')),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','human_resolved')),
 options JSONB NOT NULL, recommendation TEXT, raised_by TEXT NOT NULL,
 option_id UUID, resolution TEXT, resolved_by TEXT, resolved_at TIMESTAMPTZ, version INT NOT NULL DEFAULT 1
);
CREATE TABLE decision_impacts (
 decision_id UUID NOT NULL REFERENCES decisions(id), change_id UUID NOT NULL REFERENCES changes(id),
 PRIMARY KEY(decision_id, change_id)
);
CREATE TABLE relation_feedback (
 id UUID PRIMARY KEY, repo TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 from_change_id UUID NOT NULL REFERENCES changes(id), to_change_id UUID NOT NULL REFERENCES changes(id),
 member TEXT NOT NULL, relation TEXT NOT NULL CHECK(relation IN ('same_work','related_but_distinct','not_related','intentional_parallel')),
 CHECK(from_change_id != to_change_id)
);
CREATE TABLE domain_events (
 id UUID PRIMARY KEY, repo TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 action TEXT NOT NULL, actor TEXT NOT NULL, aggregate_id UUID, data JSONB NOT NULL
);
CREATE TABLE mutation_requests (
 id UUID PRIMARY KEY, repo TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
 request_id UUID NOT NULL, request_hash TEXT NOT NULL, response JSONB NOT NULL
);
CREATE UNIQUE INDEX mutations_key_idx ON mutation_requests(repo, actor, action, request_id);
