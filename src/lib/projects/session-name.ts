export const PROJECT_SESSION_PREFIX = "hive-project-";

export function isProjectSessionName(name: string) {
  return name.startsWith(PROJECT_SESSION_PREFIX);
}
