export function discoveryErrorStatus(message: string): number {
  if (
    message === "Not authenticated" ||
    /Request failed: 401\b|No Coder API token stored|User .+ not found/.test(message)
  )
    return 401;
  if (/Only the workspace owner|Request failed: 403\b/.test(message)) return 403;
  if (/Request failed: 404\b/.test(message)) return 404;
  if (message === "Start this workspace first.") return 409;
  return 503;
}
