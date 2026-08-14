-- Remove the retired asynchronous task runner and its task-owned workspaces.
DROP TABLE IF EXISTS "workspaces";
DROP TABLE IF EXISTS "task_logs";
DROP TABLE IF EXISTS "tasks";

DROP TYPE IF EXISTS "WorkspaceStatus";
DROP TYPE IF EXISTS "TaskStatus";
