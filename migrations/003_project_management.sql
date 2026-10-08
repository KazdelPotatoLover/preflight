CREATE TABLE projects (
 id UUID PRIMARY KEY, repo TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','archived')),
 planning_agents JSONB NOT NULL DEFAULT '[]', is_default BOOLEAN NOT NULL DEFAULT false,
 version INT NOT NULL DEFAULT 1 CHECK(version > 0)
);
CREATE UNIQUE INDEX projects_default_repo_idx ON projects(repo) WHERE is_default;
INSERT INTO projects(id, repo, title, is_default) SELECT gen_random_uuid(), repo, '默认项目', true FROM goals GROUP BY repo;
CREATE TABLE milestones (
 id UUID PRIMARY KEY, repo TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 project_id UUID NOT NULL REFERENCES projects(id), title TEXT NOT NULL, due_date TEXT,
 state TEXT NOT NULL DEFAULT 'planned' CHECK(state IN ('planned','archived')), version INT NOT NULL DEFAULT 1 CHECK(version > 0)
);
ALTER TABLE goals ADD COLUMN project_id UUID REFERENCES projects(id);
UPDATE goals SET project_id = projects.id FROM projects WHERE goals.repo = projects.repo AND projects.is_default;
ALTER TABLE goals ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE goals ADD COLUMN milestone_id UUID REFERENCES milestones(id);
ALTER TABLE goals ADD COLUMN plan_state TEXT NOT NULL DEFAULT 'ready' CHECK(plan_state IN ('backlog','ready','paused','cancelled','archived'));
ALTER TABLE goals ADD COLUMN priority INT NOT NULL DEFAULT 2 CHECK(priority BETWEEN 1 AND 4);
ALTER TABLE goals ADD COLUMN rank INT NOT NULL DEFAULT 0;
ALTER TABLE goals ADD COLUMN due_date TEXT;
ALTER TABLE goals ADD COLUMN owner TEXT;
ALTER TABLE goals ADD COLUMN kind TEXT NOT NULL DEFAULT 'requirement' CHECK(kind IN ('requirement','bug'));
ALTER TABLE goals ADD COLUMN version INT NOT NULL DEFAULT 1 CHECK(version > 0);
ALTER TABLE goals ADD COLUMN definition_version INT NOT NULL DEFAULT 1 CHECK(definition_version > 0);
ALTER TABLE changes ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'legacy' CHECK(lifecycle IN ('legacy','managed'));
ALTER TABLE changes ADD COLUMN task_acceptance JSONB NOT NULL DEFAULT '[]';
ALTER TABLE changes ADD COLUMN goal_criteria_indices JSONB NOT NULL DEFAULT '[]';
ALTER TABLE changes ADD COLUMN definition_version INT NOT NULL DEFAULT 1 CHECK(definition_version > 0);
ALTER TABLE changes ADD COLUMN goal_definition_version INT NOT NULL DEFAULT 1 CHECK(goal_definition_version > 0);
ALTER TABLE changes ADD COLUMN claim_epoch INT NOT NULL DEFAULT 0;
CREATE TABLE change_dependencies (
 change_id UUID NOT NULL REFERENCES changes(id), depends_on_id UUID NOT NULL REFERENCES changes(id),
 PRIMARY KEY(change_id, depends_on_id), CHECK(change_id != depends_on_id)
);
CREATE TABLE work_claims (
 id UUID PRIMARY KEY, repo TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 change_id UUID NOT NULL REFERENCES changes(id), session_id UUID NOT NULL REFERENCES sessions(id),
 member TEXT NOT NULL, epoch INT NOT NULL CHECK(epoch > 0), expires_at TIMESTAMPTZ NOT NULL, released_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX work_claims_current_idx ON work_claims(change_id) WHERE released_at IS NULL;
ALTER TABLE findings DROP CONSTRAINT findings_kind_check;
ALTER TABLE findings ADD CONSTRAINT findings_kind_check CHECK(kind IN ('observation','hypothesis','root_cause','constraint','test_result','failed_attempt','patch_summary'));
ALTER TABLE findings ADD COLUMN detail TEXT;
ALTER TABLE findings ADD COLUMN conditions TEXT;
ALTER TABLE findings ADD COLUMN evidence JSONB NOT NULL DEFAULT '[]';
ALTER TABLE findings ADD COLUMN refutes_id UUID REFERENCES findings(id);
ALTER TABLE findings ADD COLUMN supersedes_id UUID REFERENCES findings(id);
