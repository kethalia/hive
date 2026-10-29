/* Hive native guardian protocol 1. Standalone foundation, NOT cleanup authority.
 * One waiter owns one immutable root/ownership set. Never installed by this file.
 */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define MAX_FRAME 32768
#define MAX_ROOTS 8
#define MAX_PROJECTS 32
#define MAX_ARGS 128
#define MAX_ENV 16
#define CONTROL 3
#define WALL __WALL

enum phase { BOOT, READY, OPEN, CLOSED, HELD, DRAINED };
struct input { const unsigned char *p; size_t n, at; bool bad; };
struct root {
  char *id, *argv[MAX_ARGS + 1], *env[MAX_ENV + 1];
  int executable, cwd; unsigned role; struct stat pinned; pid_t pid; int pidfd;
};
static struct root roots[MAX_ROOTS];
static unsigned root_count, project_count, generation = 1, closed_request, drain_request;
static char *projects[MAX_PROJECTS], *project_bindings[MAX_PROJECTS];
static char *lifetime, *binding, *ownership, *launch_set;
static enum phase state = BOOT;
static unsigned reaped_count;
static bool channel_live = true;
static long ms(void) {
  struct timespec t; if (clock_gettime(CLOCK_MONOTONIC, &t)) _exit(120);
  return t.tv_sec * 1000L + t.tv_nsec / 1000000;
}
static uint32_t u32(struct input *in) {
  if (in->at + 4 > in->n) { in->bad = true; return 0; }
  uint32_t v; memcpy(&v, in->p + in->at, 4); in->at += 4; return ntohl(v);
}
static uint64_t u64(struct input *in) { uint64_t hi = u32(in); return (hi << 32) | u32(in); }
static char *str(struct input *in, unsigned limit) {
  unsigned n = u32(in);
  if (n > limit || in->at + n > in->n) { in->bad = true; return NULL; }
  char *s = calloc(n + 1, 1); if (!s) _exit(121);
  memcpy(s, in->p + in->at, n); in->at += n;
  if (memchr(s, '\0', n)) in->bad = true;
  return s;
}
static bool hex(const char *s, unsigned n) {
  if (!s || strlen(s) != n) return false;
  for (unsigned i = 0; i < n; ++i) if (!strchr("0123456789abcdef", s[i])) return false;
  return true;
}
static bool uuid(const char *s) {
  if (!s || strlen(s) != 36) return false;
  for (unsigned i = 0; i < 36; ++i) {
    if (i == 8 || i == 13 || i == 18 || i == 23) { if (s[i] != '-') return false; }
    else if (!strchr("0123456789abcdef", s[i])) return false;
  }
  return true;
}
static bool name(const char *s) {
  if (!s || !*s || strlen(s) > 64) return false;
  for (; *s; ++s) if (!strchr("abcdefghijklmnopqrstuvwxyz0123456789_-", *s)) return false;
  return true;
}
static bool env_allowed(const char *s) {
  const char *names[] = {"PATH=", "HOME=", "CODEX_HOME=", "USER=", "LANG=", "LC_ALL=", "TERM=", "HIVE_NATIVE_CODEX_TOKEN="};
  if (!s) return false;
  for (unsigned i = 0; i < sizeof(names)/sizeof(names[0]); ++i)
    if (strncmp(s, names[i], strlen(names[i])) == 0) return true;
  return false;
}
static bool pinned_stat(const struct stat *a, const struct stat *b) {
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino && a->st_size == b->st_size &&
    a->st_mode == b->st_mode && a->st_uid == b->st_uid &&
    a->st_mtim.tv_sec == b->st_mtim.tv_sec && a->st_mtim.tv_nsec == b->st_mtim.tv_nsec &&
    a->st_ctim.tv_sec == b->st_ctim.tv_sec && a->st_ctim.tv_nsec == b->st_ctim.tv_nsec;
}
static bool send_frame(const char *s) {
  unsigned char data[2048]; size_t n = strlen(s);
  if (n > sizeof(data) - 4) return false;
  uint32_t net = htonl(n); memcpy(data, &net, 4); memcpy(data + 4, s, n);
  size_t at = 0; long end = ms() + 1000;
  while (at < n + 4 && ms() < end) {
    ssize_t wrote = send(CONTROL, data + at, n + 4 - at, MSG_NOSIGNAL | MSG_DONTWAIT);
    if (wrote > 0) { at += wrote; continue; }
    if (wrote < 0 && (errno == EAGAIN || errno == EINTR)) {
      struct pollfd p = { CONTROL, POLLOUT, 0 }; poll(&p, 1, 10); continue;
    }
    return false;
  }
  return at == n + 4;
}
static const char *phase_name(void) {
  const char *values[] = {"boot", "ready", "open", "closed", "held", "drained"}; return values[state];
}
static void response(char *out, unsigned id, const char *code, pid_t pid) {
  snprintf(out, 2048,
    "{\"protocolVersion\":1,\"requestId\":%u,\"code\":\"%s\",\"phase\":\"%s\","
    "\"generation\":%u,\"lifetimeId\":\"%s\",\"bindingDigest\":\"%s\",\"ownershipDigest\":\"%s\","
    "\"launchSetDigest\":\"%s\",\"rootPid\":%d,\"closedRequestId\":%u,\"drainRequestId\":%u,\"reaped\":%u}",
    id, code, phase_name(), generation, lifetime ? lifetime : "", binding ? binding : "",
    ownership ? ownership : "", launch_set ? launch_set : "", pid, closed_request, drain_request, reaped_count);
}
static bool child_kill(pid_t pid) {
  int fd = syscall(SYS_pidfd_open, pid, 0);
  if (fd < 0) return errno == ESRCH;
  siginfo_t si = {0};
  int ok = waitid(P_PIDFD, fd, &si, WEXITED | WNOHANG | WNOWAIT | WALL);
  if (ok == 0) ok = syscall(SYS_pidfd_send_signal, fd, SIGKILL, NULL, 0);
  bool result = ok == 0 || (ok < 0 && errno == ESRCH);
  close(fd); return result;
}
static bool target_children(void) {
  char path[96]; snprintf(path, sizeof(path), "/proc/self/task/%d/children", getpid());
  FILE *f = fopen(path, "r"); if (!f) return false;
  unsigned count = 0; int pid; bool ok = true;
  while (fscanf(f, "%d", &pid) == 1) {
    if (++count > 128 || pid <= 1 || !child_kill(pid)) { ok = false; break; }
  }
  if (ferror(f)) ok = false;
  fclose(f); return ok;
}
static bool drain(void) {
  state = HELD; long end = ms() + 4000; unsigned calls = 0, reaped = 0;
  while (ms() < end) {
    if (!target_children()) return false;
    pid_t pid; int status;
    do {
      if (++calls > 2048 || reaped >= 512 || ms() >= end) return false;
      pid = waitpid(-1, &status, WNOHANG | WALL);
      if (pid > 0) { ++reaped; ++reaped_count; }
    } while (pid > 0);
    if (pid < 0 && errno == ECHILD) { state = DRAINED; return true; }
    if (pid < 0 && errno != EINTR) return false;
    usleep(10000);
  }
  return false;
}
static bool bootstrap(struct input *in) {
  if (u32(in) != 1) return false;
  lifetime = str(in, 36); binding = str(in, 64); ownership = str(in, 64); launch_set = str(in, 64);
  if (!uuid(lifetime) || !hex(binding, 64) || !hex(ownership, 64) || !hex(launch_set, 64)) return false;
  project_count = u32(in);
  if (!project_count || project_count > MAX_PROJECTS) return false;
  for (unsigned i = 0; i < project_count; ++i) {
    projects[i] = str(in, 36); project_bindings[i] = str(in, 64);
    if (!uuid(projects[i]) || !hex(project_bindings[i], 64)) return false;
    for (unsigned j = 0; j < i; ++j) if (!strcmp(projects[j], projects[i])) return false;
  }
  root_count = u32(in); if (!root_count || root_count > MAX_ROOTS) return false;
  for (unsigned i = 0; i < root_count; ++i) {
    struct root *r = &roots[i]; r->pidfd = -1; r->id = str(in, 64); r->role = u32(in);
    r->executable = u32(in); r->cwd = u32(in);
    if (r->role < 1 || r->role > 3 || !name(r->id) || r->executable != 4 + (int)i * 2 || r->cwd != r->executable + 1) return false;
    for (unsigned j = 0; j < i; ++j) if (!strcmp(roots[j].id, r->id)) return false;
    struct stat expected = {0}, directory;
    expected.st_dev = u64(in); expected.st_ino = u64(in); expected.st_size = u64(in);
    expected.st_mode = u32(in); expected.st_uid = u32(in);
    expected.st_mtim.tv_sec = u64(in); expected.st_mtim.tv_nsec = u32(in);
    expected.st_ctim.tv_sec = u64(in); expected.st_ctim.tv_nsec = u32(in);
    if (fstat(r->executable, &r->pinned) || !pinned_stat(&expected, &r->pinned) ||
        !S_ISREG(r->pinned.st_mode) || (r->pinned.st_mode & 022) ||
        (r->pinned.st_uid != 0 && r->pinned.st_uid != getuid()) ||
        fstat(r->cwd, &directory) || !S_ISDIR(directory.st_mode) ||
        directory.st_uid != getuid() || (directory.st_mode & 022)) return false;
    char magic[4]; if (pread(r->executable, magic, 4, 0) != 4 || memcmp(magic, "\177ELF", 4)) return false;
    unsigned args = u32(in); if (!args || args > MAX_ARGS) return false;
    for (unsigned j = 0; j < args; ++j) r->argv[j] = str(in, 4096);
    unsigned envs = u32(in); if (envs > MAX_ENV) return false;
    for (unsigned j = 0; j < envs; ++j) {
      r->env[j] = str(in, 4096); if (!env_allowed(r->env[j])) return false;
      const char *equal = strchr(r->env[j], '='); size_t size = (size_t)(equal - r->env[j]) + 1;
      for (unsigned k = 0; k < j; ++k) if (!strncmp(r->env[k], r->env[j], size)) return false;
    }
  }
  if (in->bad || in->at != in->n) return false;
  // No ambient descriptor may be retained beyond the explicitly pinned set.
  if (syscall(SYS_close_range, 4 + root_count * 2, UINT_MAX, 0)) return false;
  state = READY; return true;
}
static void child_error(int fd) {
  int error = errno ? errno : EIO; if (write(fd, &error, sizeof(error)) != sizeof(error)) _exit(125); _exit(123);
}
static pid_t launch(unsigned index) {
  if (index >= root_count) return -1;
  struct root *r = &roots[index]; struct stat current;
  if (r->pid || fstat(r->executable, &current) || !pinned_stat(&r->pinned, &current)) return -1;
  int status_pipe[2]; if (pipe2(status_pipe, O_CLOEXEC)) return -1;
  pid_t pid = fork();
  if (pid == 0) {
    close(status_pipe[0]);
    int exec_fd = fcntl(r->executable, F_DUPFD_CLOEXEC, 64);
    int report_fd = fcntl(status_pipe[1], F_DUPFD_CLOEXEC, 65);
    if (exec_fd != 64 || report_fd != 65 || fchdir(r->cwd)) child_error(status_pipe[1]);
    int null = open("/dev/null", O_RDWR); if (null < 0) child_error(report_fd);
    for (int i = 0; i <= 2; ++i) if (dup2(null, i) != i) child_error(report_fd);
    if (syscall(SYS_close_range, 3, 63, 0) || syscall(SYS_close_range, 66, UINT_MAX, 0)) child_error(report_fd);
    fexecve(exec_fd, r->argv, r->env);
    int error = errno; if (write(report_fd, &error, sizeof(error)) != sizeof(error)) _exit(125); _exit(124);
  }
  close(status_pipe[1]);
  if (pid < 0) { close(status_pipe[0]); return -1; }
  r->pid = pid; r->pidfd = syscall(SYS_pidfd_open, pid, 0);
  struct pollfd p = { status_pipe[0], POLLIN | POLLHUP, 0 };
  int ready = poll(&p, 1, 1000), error = 0;
  ssize_t n = ready > 0 ? read(status_pipe[0], &error, sizeof(error)) : -1;
  close(status_pipe[0]);
  if (r->pidfd < 0 || ready <= 0 || n != 0) return -1;
  return pid;
}
static bool close_admission(struct input *in, unsigned id) {
  unsigned requested = u32(in); char *digest = str(in, 64);
  unsigned count = u32(in); bool ok = requested == generation && digest && ownership &&
    strcmp(digest, ownership) == 0 && count == project_count;
  free(digest);
  for (unsigned i = 0; i < count && i < MAX_PROJECTS; ++i) {
    char *project = str(in, 36), *bind = str(in, 64), *decision = str(in, 36);
    ok = ok && i < project_count && project && bind && uuid(decision) &&
      !strcmp(project, projects[i]) && !strcmp(bind, project_bindings[i]);
    free(project); free(bind); free(decision);
  }
  if (!ok || in->bad || in->at != in->n) return false;
  state = CLOSED; closed_request = id; ++generation; return true;
}
int main(int argc, char **argv) {
  if (argc != 2 || strcmp(argv[1], "--private-fd-v1")) return 100;
  struct ucred peer; socklen_t size = sizeof(peer);
  if (getsockopt(CONTROL, SOL_SOCKET, SO_PEERCRED, &peer, &size) ||
      peer.pid != getppid() || peer.uid != getuid()) return 101;
  struct sigaction sa = { .sa_handler = SIG_DFL }; sigemptyset(&sa.sa_mask);
  if (sigaction(SIGCHLD, &sa, NULL) || prctl(PR_SET_CHILD_SUBREAPER, 1L)) return 102;
  int enabled = 0; if (prctl(PR_GET_CHILD_SUBREAPER, &enabled) || enabled != 1) return 102;
  unsigned char data[MAX_FRAME + 4], previous[MAX_FRAME];
  size_t used = 0, previous_size = 0; unsigned last_id = 0;
  char last_response[2048] = {0}; long partial_since = 0, bootstrap_deadline = ms() + 5000;
  bool acknowledged = false;
  while (channel_live && !acknowledged) {
    if (state == OPEN) {
      for (unsigned i = 0; i < root_count; ++i) if (roots[i].pidfd >= 0 && roots[i].role != 3) {
        struct pollfd root = { roots[i].pidfd, POLLIN, 0 };
        if (poll(&root, 1, 0) > 0) channel_live = false;
      }
      if (!channel_live) break;
    }
    struct pollfd p = { CONTROL, POLLIN | POLLHUP, 0 };
    int ready = poll(&p, 1, 50);
    if (ready < 0) { if (errno == EINTR) continue; break; }
    if (!ready) {
      if ((state == BOOT && ms() > bootstrap_deadline) || (partial_since && ms() - partial_since > 1000)) break;
      continue;
    }
    ssize_t n = recv(CONTROL, data + used, sizeof(data) - used, MSG_DONTWAIT);
    if (n < 0 && (errno == EAGAIN || errno == EINTR)) continue;
    if (n <= 0) break;
    if (!used) partial_since = ms();
    used += n;
    while (used >= 4) {
      uint32_t net; memcpy(&net, data, 4); unsigned length = ntohl(net);
      if (length < 8 || length > MAX_FRAME) { channel_live = false; break; }
      if (used < length + 4) break;
      struct input in = { data + 4, length, 0, false };
      unsigned op = u32(&in), id = u32(&in); pid_t pid = 0; const char *code = "ok";
      if (id == last_id && previous_size == length && !memcmp(previous, data + 4, length)) {
        if (!send_frame(last_response)) channel_live = false;
      } else {
        if (!id || id != last_id + 1) { code = "sequence_rejected"; channel_live = false; }
        else if (op == 1 && state == BOOT) {
          if (!bootstrap(&in)) { code = "bootstrap_rejected"; channel_live = false; }
        } else if (op == 2 && state == READY && in.at == in.n) {
          if (prctl(PR_SET_DUMPABLE, 0L)) { code = "activation_rejected"; channel_live = false; }
          else state = OPEN;
        } else if (op == 3 && state == OPEN) {
          unsigned expected = u32(&in), index = u32(&in);
          if (expected != generation || in.bad || in.at != in.n || (pid = launch(index)) < 0) {
            code = "launch_rejected"; channel_live = false;
          }
        } else if (op == 4 && state == OPEN) {
          if (!close_admission(&in, id)) { code = "admission_rejected"; channel_live = false; }
        } else if (op == 5 && (state == CLOSED || state == HELD)) {
          unsigned expected = u32(&in);
          if (expected != generation || in.bad || in.at != in.n) { code = "drain_rejected"; channel_live = false; }
          else { drain_request = id; if (!drain()) code = "drain_held"; }
        } else if (op == 6 && state == DRAINED) {
          unsigned expected = u32(&in), request = u32(&in);
          if (expected != generation || request != drain_request || in.bad || in.at != in.n) { code = "receipt_rejected"; channel_live = false; }
          else acknowledged = true;
        } else { code = "operation_rejected"; channel_live = false; }
        response(last_response, id, code, pid);
        memcpy(previous, data + 4, length); previous_size = length; last_id = id;
        if (!send_frame(last_response)) channel_live = false;
      }
      used -= length + 4; memmove(data, data + length + 4, used);
      partial_since = used ? ms() : 0;
      if (!channel_live || acknowledged) break;
    }
  }
  if (acknowledged) return 0;
  // Broken/malformed controller channel revokes all execution, never emits a receipt.
  close(CONTROL);
  if (state != DRAINED && !drain()) {
    // Keep adoption ownership after an uncertain drain. No new execution/channel.
    for (;;) { sleep(5); if (drain()) break; }
  }
  return 103;
}
