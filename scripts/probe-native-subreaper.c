// Synthetic Linux-only proof, never a production drain authority.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define LIMIT 24
#define DEADLINE_MS 4000
static long now_ms(void) {
  struct timespec t;
  if (clock_gettime(CLOCK_MONOTONIC, &t)) _exit(110);
  return t.tv_sec * 1000L + t.tv_nsec / 1000000;
}
static void require(bool ok) { if (!ok) { perror("fixture_assertion"); exit(111); } }
static void nap(void) { usleep(10000); }
static unsigned long long start_ticks(pid_t pid) {
  char p[96], line[4096];
  snprintf(p, sizeof(p), "/proc/%d/stat", pid);
  FILE *f = fopen(p, "r"); require(f != NULL);
  require(fgets(line, sizeof(line), f) != NULL); fclose(f);
  char *s = strrchr(line, ')'); require(s != NULL); s += 2;
  for (int field = 3; field < 22; field++) {
    s = strchr(s, ' '); require(s != NULL); s++;
  }
  return strtoull(s, NULL, 10);
}
static void set_subreaper(void) {
  struct sigaction a = { .sa_handler = SIG_DFL };
  sigemptyset(&a.sa_mask);
  require(sigaction(SIGCHLD, &a, NULL) == 0);
  sigset_t blocked; sigemptyset(&blocked); sigaddset(&blocked, SIGUSR1);
  require(sigprocmask(SIG_BLOCK, &blocked, NULL) == 0);
  require(prctl(PR_SET_CHILD_SUBREAPER, 1L) == 0);
  int value = 0; require(prctl(PR_GET_CHILD_SUBREAPER, &value) == 0 && value == 1);
}
// Only targets a kernel-confirmed direct child. No caller-supplied PIDs.
static bool kill_child(pid_t pid) {
  int fd = syscall(SYS_pidfd_open, pid, 0);
  if (fd < 0 && errno == ESRCH) return true;
  if (fd < 0) return false;
  siginfo_t info = {0};
  int result = waitid(P_PIDFD, fd, &info, WEXITED | WNOHANG | WNOWAIT | __WALL);
  if (result < 0) { close(fd); return false; }
  result = syscall(SYS_pidfd_send_signal, fd, SIGKILL, NULL, 0);
  bool ok = result == 0 || errno == ESRCH;
  close(fd); return ok;
}
// Proc is ONLY a targeting hint. A missing candidate cannot produce success.
static bool target_children(void) {
  char path[96]; snprintf(path, sizeof(path), "/proc/self/task/%d/children", getpid());
  FILE *f = fopen(path, "r"); if (!f) return false;
  int pid, count = 0; bool ok = true;
  while (fscanf(f, "%d", &pid) == 1) {
    if (++count > LIMIT || pid <= 1 || !kill_child(pid)) { ok = false; break; }
  }
  if (ferror(f)) ok = false;
  fclose(f); return ok;
}
static bool drain(bool omit_targets, int *reaped) {
  const long end = now_ms() + DEADLINE_MS;
  unsigned wait_calls = 0;
  while (now_ms() < end) {
    if (!omit_targets && !target_children()) return false;
    int status; pid_t pid;
    do {
      // A continuously reparenting tree must not keep this inner loop alive.
      if (++wait_calls > 512 || *reaped >= 128 || now_ms() >= end) return false;
      pid = waitpid(-1, &status, WNOHANG | __WALL);
      if (pid > 0) ++*reaped;
    } while (pid > 0);
    if (pid < 0 && errno == ECHILD) return true;
    if (pid < 0 && errno != EINTR) return false;
    if (omit_targets) return false; // bounded deliberate omission control
    nap();
  }
  return false;
}
static off_t bytes(int fd) { struct stat s; require(fstat(fd, &s) == 0); return s.st_size; }
static void writer(int fd, int ready) {
  signal(SIGTERM, SIG_IGN);
  char one = 'x';
  require(write(fd, &one, 1) == 1);
  if (ready >= 0) { require(write(ready, &one, 1) == 1); close(ready); }
  for (;;) { require(write(fd, &one, 1) == 1); nap(); }
}
struct writer_args { int fd, ready, close_fd; };
static int clone_writer(void *p) {
  struct writer_args *a = p; close(a->close_fd); writer(a->fd, a->ready); return 0;
}
static void await_ready(int fd) {
  struct pollfd p = { .fd = fd, .events = POLLIN };
  require(poll(&p, 1, 2000) == 1);
  char c; require(read(fd, &c, 1) == 1); close(fd);
}
struct result { int success, omission_held, ordinary_wait_missed, reaped; };
static void supervise(const char *mode, int file, int to_parent) {
  set_subreaper();
  int ready[2]; require(pipe2(ready, O_CLOEXEC) == 0);
  pid_t root;
  if (strcmp(mode, "clone_signal") == 0) {
    char *stack = malloc(128 * 1024); require(stack != NULL);
    struct writer_args a = { .fd = file, .ready = ready[1], .close_fd = to_parent };
    root = clone(clone_writer, stack + 128 * 1024, SIGUSR1, &a);
    require(root > 0);
    close(ready[1]); await_ready(ready[0]);
  } else {
    root = fork(); require(root >= 0);
    if (root == 0) {
      close(ready[0]); close(to_parent);
      if (strcmp(mode, "nested_subreaper") == 0) set_subreaper();
      pid_t mid = fork(); require(mid >= 0);
      if (mid == 0) {
        require(setsid() >= 0);
        pid_t daemon = fork(); require(daemon >= 0);
        if (daemon > 0) _exit(0);
        writer(file, ready[1]);
      }
      close(ready[1]);
      for (;;) pause();
    }
    close(ready[1]); await_ready(ready[0]);
  }
  struct result r = {0};
  // Clone child is alive; ordinary wait falsely excludes it.
  if (strcmp(mode, "clone_signal") == 0) {
    siginfo_t info = {0}; errno = 0;
    r.ordinary_wait_missed = waitid(P_ALL, 0, &info, WEXITED | WNOHANG) < 0 && errno == ECHILD;
    require(r.ordinary_wait_missed);
  }
  off_t before = bytes(file); usleep(60000); require(bytes(file) > before);
  char ready_byte = 'r'; require(write(to_parent, &ready_byte, 1) == 1);
  if (strcmp(mode, "supervisor_crash") == 0) for (;;) pause();
  // Close admission: no further supervisor fork/clone is reachable below here.
  int ignored = 0; r.omission_held = !drain(true, &ignored);
  require(r.omission_held);
  require(kill_child(root));
  r.success = drain(false, &r.reaped);
  require(r.success);
  off_t stopped = bytes(file); usleep(60000); require(bytes(file) == stopped);
  require(write(to_parent, &r, sizeof(r)) == sizeof(r)); close(to_parent);
  _exit(0);
}
static void deadline_signal(int sig) { (void)sig; }
static pid_t driver_pid;
static void cleanup_on_exit(void) {
  if (driver_pid == getpid()) { int n = 0; if (!drain(false, &n)) fprintf(stderr, "fixture_cleanup_held\n"); }
}
static int native_fixture(int argc, char **argv) {
  require(argc >= 4);
  set_subreaper(); driver_pid = getpid(); require(atexit(cleanup_on_exit) == 0);
  struct sigaction deadline = { .sa_handler = deadline_signal };
  sigemptyset(&deadline.sa_mask); require(sigaction(SIGALRM, &deadline, NULL) == 0);
  alarm(20);
  pid_t root = fork(); require(root >= 0);
  if (root == 0) {
    close(STDIN_FILENO); require(open("/dev/null", O_RDONLY) == STDIN_FILENO);
    int sink = open("/dev/null", O_WRONLY); require(sink >= 0);
    require(dup2(sink, STDOUT_FILENO) == STDOUT_FILENO); close(sink);
    execv(argv[2], &argv[2]); _exit(112);
  }
  printf("{\"started\":true,\"rootPid\":%d,\"rootStartTicks\":%llu}\n", root, start_ticks(root));
  fflush(stdout);
  char command; require(read(STDIN_FILENO, &command, 1) == 1 && command == 'D');
  int reaped = 0; bool ok = drain(false, &reaped);
  printf("{\"admissionClosed\":true,\"finalEchild\":%s,\"reaped\":%d}\n", ok ? "true":"false", reaped);
  fflush(stdout); return ok ? 0 : 113;
}
int main(int argc, char **argv) {
  if (argc > 2 && strcmp(argv[1], "--native-fixture") == 0) return native_fixture(argc, argv);
  require(argc == 2);
  const char *mode = argv[1];
  require(strcmp(mode,"detached") == 0 || strcmp(mode,"nested_subreaper") == 0 ||
          strcmp(mode,"clone_signal") == 0 || strcmp(mode,"supervisor_crash") == 0);
  // Test driver, not production authority: contains the intentional crash case.
  set_subreaper(); driver_pid = getpid(); require(atexit(cleanup_on_exit) == 0);
  struct sigaction deadline = { .sa_handler = deadline_signal };
  sigemptyset(&deadline.sa_mask); require(sigaction(SIGALRM, &deadline, NULL) == 0);
  alarm(8); // Interrupt blocking driver waits; atexit retains bounded child cleanup.
  char data[] = "/tmp/hive-subreaper-writer-XXXXXX";
  int file = mkstemp(data); require(file >= 0); require(unlink(data) == 0);
  char other[] = "/tmp/hive-subreaper-outside-XXXXXX";
  int outside_file = mkstemp(other); require(outside_file >= 0); require(unlink(other) == 0);
  pid_t outside = fork(); require(outside >= 0);
  if (outside == 0) { close(file); writer(outside_file, -1); }
  int result_pipe[2]; require(pipe2(result_pipe, O_CLOEXEC) == 0);
  pid_t supervisor = fork(); require(supervisor >= 0);
  if (supervisor == 0) { close(outside_file); close(result_pipe[0]); supervise(mode, file, result_pipe[1]); }
  close(result_pipe[1]);
  unsigned long long supervisor_start = start_ticks(supervisor);
  struct pollfd p = { .fd = result_pipe[0], .events = POLLIN };
  require(poll(&p, 1, 2500) == 1);
  char c; require(read(result_pipe[0], &c, 1) == 1);
  bool crashed = strcmp(mode, "supervisor_crash") == 0;
  struct result r = {0}; bool survived_crash = false;
  if (crashed) {
    require(kill_child(supervisor));
    int status; require(waitpid(supervisor, &status, 0) == supervisor && WIFSIGNALED(status));
    off_t prior = bytes(file); usleep(80000); survived_crash = bytes(file) > prior;
    require(survived_crash);
    require(read(result_pipe[0], &r, sizeof(r)) == 0); // no success receipt
  } else {
    require(poll(&p, 1, DEADLINE_MS + 1000) == 1);
    require(read(result_pipe[0], &r, sizeof(r)) == sizeof(r));
    int status; require(waitpid(supervisor, &status, 0) == supervisor && WIFEXITED(status) && WEXITSTATUS(status) == 0);
  }
  close(result_pipe[0]);
  off_t before = bytes(outside_file); usleep(60000);
  bool outside_live = bytes(outside_file) > before; require(outside_live);
  int cleanup_reaped = 0; require(drain(false, &cleanup_reaped));
  off_t end = bytes(file); usleep(60000); require(bytes(file) == end);
  printf("{\"case\":\"%s\",\"supervisorPid\":%d,\"supervisorStartTicks\":%llu,"
         "\"closedAdmissionDrainSucceeded\":%s,\"targetOmissionHeld\":%s,"
         "\"ordinaryWaitExcludedLiveClone\":%s,\"writerSurvivedSupervisorCrash\":%s,"
         "\"unrelatedWriterPreserved\":%s,\"reaped\":%d,\"fixtureCleanupEchild\":true}\n",
         mode, supervisor, supervisor_start, r.success ? "true":"false",
         r.omission_held ? "true":"false", r.ordinary_wait_missed ? "true":"false",
         survived_crash ? "true":"false", outside_live ? "true":"false", r.reaped);
  close(file); close(outside_file); return 0;
}
