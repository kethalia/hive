#define _GNU_SOURCE

#include <stdlib.h>
#include <sys/prctl.h>
#include <unistd.h>

static void guard_failure(void) {
  static const char message[] = "[error] Claude process guard failed\n";
  ssize_t diagnostic_result = write(STDERR_FILENO, message, sizeof(message) - 1);
  (void)diagnostic_result;
  _exit(125);
}

__attribute__((constructor)) static void protect_claude_process(void) {
  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) {
    guard_failure();
  }

  /* Defense in depth for hooks, commands, and stdio MCP servers. */
  if (unsetenv("ANTHROPIC_AUTH_TOKEN") != 0 ||
      unsetenv("CLAUDE_CODE_OAUTH_TOKEN") != 0 ||
      unsetenv("CLAUDE_CODE_OAUTH_REFRESH_TOKEN") != 0 ||
      unsetenv("CLAUDE_CODE_OAUTH_SCOPES") != 0) {
    guard_failure();
  }
}
