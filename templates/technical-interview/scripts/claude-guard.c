#define _GNU_SOURCE

#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <unistd.h>

#define INTERVIEW_KEY_MAX 16384

static void guard_failure(void) {
  static const char message[] = "[error] Claude credential guard failed\n";
  (void)write(STDERR_FILENO, message, sizeof(message) - 1);
  _exit(125);
}

static int descriptor_from_environment(const char *name) {
  const char *descriptor_text = getenv(name);
  char *descriptor_end = NULL;
  long descriptor_long;

  if (descriptor_text == NULL || descriptor_text[0] == '\0') {
    guard_failure();
  }
  errno = 0;
  descriptor_long = strtol(descriptor_text, &descriptor_end, 10);
  if (errno != 0 || descriptor_end == descriptor_text || *descriptor_end != '\0' \
      || descriptor_long < 0 || descriptor_long > INT_MAX) {
    guard_failure();
  }
  if (unsetenv(name) != 0) {
    guard_failure();
  }
  return (int)descriptor_long;
}

__attribute__((constructor)) static void protect_claude_credentials(void) {
  char key[INTERVIEW_KEY_MAX + 1];
  const char *key_descriptor_text;
  int key_descriptor;
  int ready_descriptor;
  size_t length = 0;

  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) {
    guard_failure();
  }

  key_descriptor_text = getenv("HIVE_INTERVIEW_KEY_FD");
  if (key_descriptor_text == NULL || key_descriptor_text[0] == '\0') {
    return;
  }
  key_descriptor = descriptor_from_environment("HIVE_INTERVIEW_KEY_FD");
  ready_descriptor = descriptor_from_environment("HIVE_INTERVIEW_READY_FD");
  if (write(ready_descriptor, "R", 1) != 1) {
    guard_failure();
  }
  (void)close(ready_descriptor);

  while (length < INTERVIEW_KEY_MAX) {
    ssize_t received = read(key_descriptor, key + length, INTERVIEW_KEY_MAX - length);
    if (received == 0) {
      break;
    }
    if (received < 0) {
      if (errno == EINTR) {
        continue;
      }
      guard_failure();
    }
    length += (size_t)received;
  }
  if (length == 0 || length == INTERVIEW_KEY_MAX) {
    guard_failure();
  }
  key[length] = '\0';
  if (setenv("ANTHROPIC_API_KEY", key, 1) != 0) {
    guard_failure();
  }
  (void)close(key_descriptor);
  explicit_bzero(key, sizeof(key));
}
