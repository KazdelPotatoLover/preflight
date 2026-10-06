ALTER TABLE decisions DROP CONSTRAINT decisions_status_check;
ALTER TABLE decisions ADD COLUMN authority TEXT NOT NULL DEFAULT 'within_goal'
 CHECK (authority IN ('within_goal','goal_boundary','missing_information'));
ALTER TABLE decisions ADD COLUMN review_round INT NOT NULL DEFAULT 1 CHECK (review_round BETWEEN 1 AND 3);
ALTER TABLE decisions ADD COLUMN review_epoch INT NOT NULL DEFAULT 1 CHECK (review_epoch > 0);
UPDATE decisions SET status = 'negotiating' WHERE status = 'pending';
ALTER TABLE decisions ALTER COLUMN status SET DEFAULT 'negotiating';
ALTER TABLE decisions ADD CONSTRAINT decisions_status_check
 CHECK (status IN ('negotiating','agent_resolved','deferred','needs_input','human_resolved'));
CREATE TABLE decision_reviews (
 id UUID PRIMARY KEY, repo TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 decision_id UUID NOT NULL REFERENCES decisions(id), review_epoch INT NOT NULL CHECK(review_epoch > 0),
 review_round INT NOT NULL CHECK(review_round BETWEEN 1 AND 3),
 change_id UUID NOT NULL REFERENCES changes(id), session_id UUID NOT NULL REFERENCES sessions(id),
 member TEXT NOT NULL, stance TEXT NOT NULL CHECK(stance IN ('accept','object')), option_id UUID,
 rationale TEXT NOT NULL, evidence JSONB NOT NULL,
 CHECK(stance != 'accept' OR option_id IS NOT NULL)
);
CREATE UNIQUE INDEX decision_reviews_round_change_idx ON decision_reviews(decision_id, review_epoch, review_round, change_id);
INSERT INTO domain_events(id, repo, actor, action, aggregate_id, data)
 SELECT gen_random_uuid(), repo, 'migration', 'decision.coordination_migrated', id,
 jsonb_build_object('authority', authority, 'status', status, 'source', 'schema_migration_002')
 FROM decisions WHERE status = 'negotiating';
