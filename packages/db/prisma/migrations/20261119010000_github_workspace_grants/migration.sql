CREATE TABLE github_workspace_grants (
  workspace_id uuid NOT NULL, repo_id text NOT NULL,
  access text NOT NULL CHECK (access IN ('none', 'read', 'write')),
  revision uuid NOT NULL, installation_id text NOT NULL,
  credential text, expires_at timestamptz,
  PRIMARY KEY (workspace_id, repo_id),
  CHECK ((credential IS NULL) = (expires_at IS NULL))
);
