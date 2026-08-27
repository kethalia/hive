#define _GNU_SOURCE

#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

typedef int (*connect_function)(int, const struct sockaddr *, socklen_t);
typedef int (*setsockopt_function)(int, int, int, const void *, socklen_t);

static connect_function system_connect = NULL;
static setsockopt_function system_setsockopt = NULL;
static char broker_socket_path[sizeof(((struct sockaddr_un *)0)->sun_path)];
static in_port_t broker_port = 0;
static int broker_redirect_enabled = 0;

static void guard_failure(void) {
  static const char message[] = "[error] Claude process guard failed\n";
  ssize_t diagnostic_result = write(STDERR_FILENO, message, sizeof(message) - 1);
  (void)diagnostic_result;
  _exit(125);
}

static connect_function resolve_connect(void) {
  union {
    void *object;
    connect_function function;
  } resolved;

  if (system_connect != NULL) {
    return system_connect;
  }
  dlerror();
  resolved.object = dlsym(RTLD_NEXT, "connect");
  if (resolved.object == NULL || dlerror() != NULL) {
    guard_failure();
  }
  system_connect = resolved.function;
  return system_connect;
}

static setsockopt_function resolve_setsockopt(void) {
  union {
    void *object;
    setsockopt_function function;
  } resolved;

  if (system_setsockopt != NULL) {
    return system_setsockopt;
  }
  dlerror();
  resolved.object = dlsym(RTLD_NEXT, "setsockopt");
  if (resolved.object == NULL || dlerror() != NULL) {
    guard_failure();
  }
  system_setsockopt = resolved.function;
  return system_setsockopt;
}

static int broker_destination(const struct sockaddr *address, socklen_t address_length) {
  const struct sockaddr_in *internet_address;

  if (!broker_redirect_enabled || address == NULL ||
      address_length < (socklen_t)sizeof(struct sockaddr_in) ||
      address->sa_family != AF_INET) {
    return 0;
  }
  internet_address = (const struct sockaddr_in *)address;
  return internet_address->sin_port == broker_port &&
         internet_address->sin_addr.s_addr == htonl(INADDR_LOOPBACK);
}

static int replace_with_unix_socket(int socket_descriptor) {
  int replacement;
  int replacement_flags = SOCK_STREAM | SOCK_CLOEXEC;
  int status_flags;
  int socket_type;
  socklen_t socket_type_length = sizeof(socket_type);

  if (getsockopt(socket_descriptor, SOL_SOCKET, SO_TYPE, &socket_type,
                 &socket_type_length) != 0 ||
      socket_type != SOCK_STREAM) {
    errno = EPROTOTYPE;
    return -1;
  }
  status_flags = fcntl(socket_descriptor, F_GETFL);
  if (status_flags < 0) {
    return -1;
  }
  if ((status_flags & O_NONBLOCK) != 0) {
    replacement_flags |= SOCK_NONBLOCK;
  }
  replacement = socket(AF_UNIX, replacement_flags, 0);
  if (replacement < 0) {
    return -1;
  }
  /* Never allow a Claude-spawned command to inherit an authenticated channel. */
  if (dup3(replacement, socket_descriptor, O_CLOEXEC) < 0) {
    int saved_errno = errno;
    close(replacement);
    errno = saved_errno;
    return -1;
  }
  close(replacement);
  return 0;
}

int connect(int socket_descriptor, const struct sockaddr *address,
            socklen_t address_length) {
  connect_function next_connect = resolve_connect();

  if (broker_destination(address, address_length)) {
    struct sockaddr_un unix_address;
    socklen_t unix_address_length;

    if (replace_with_unix_socket(socket_descriptor) != 0) {
      return -1;
    }
    memset(&unix_address, 0, sizeof(unix_address));
    unix_address.sun_family = AF_UNIX;
    memcpy(unix_address.sun_path, broker_socket_path,
           strlen(broker_socket_path) + 1);
    unix_address_length =
        (socklen_t)(offsetof(struct sockaddr_un, sun_path) +
                    strlen(broker_socket_path) + 1);
    return next_connect(socket_descriptor, (const struct sockaddr *)&unix_address,
                        unix_address_length);
  }
  return next_connect(socket_descriptor, address, address_length);
}

int setsockopt(int socket_descriptor, int level, int option_name,
               const void *option_value, socklen_t option_length) {
  setsockopt_function next_setsockopt = resolve_setsockopt();
  int socket_domain = 0;
  socklen_t socket_domain_length = sizeof(socket_domain);

  if (level == IPPROTO_TCP &&
      getsockopt(socket_descriptor, SOL_SOCKET, SO_DOMAIN, &socket_domain,
                 &socket_domain_length) == 0 &&
      socket_domain == AF_UNIX) {
    return 0;
  }
  return next_setsockopt(socket_descriptor, level, option_name, option_value,
                         option_length);
}

__attribute__((constructor)) static void protect_claude_process(void) {
  const char *port_value = getenv("HIVE_INTERVIEW_BROKER_PORT");
  const char *socket_value = getenv("HIVE_INTERVIEW_BROKER_SOCKET");

  if ((port_value == NULL) != (socket_value == NULL)) {
    guard_failure();
  }
  if (port_value != NULL && socket_value != NULL) {
    char *port_end = NULL;
    long parsed_port;
    size_t socket_length = strlen(socket_value);

    errno = 0;
    parsed_port = strtol(port_value, &port_end, 10);
    if (errno != 0 || port_end == port_value || *port_end != '\0' ||
        parsed_port < 1024 || parsed_port > 65535 || socket_value[0] != '/' ||
        socket_length == 0 || socket_length >= sizeof(broker_socket_path)) {
      guard_failure();
    }
    memcpy(broker_socket_path, socket_value, socket_length + 1);
    broker_port = htons((uint16_t)parsed_port);
    broker_redirect_enabled = 1;
  }

  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) {
    guard_failure();
  }
  (void)resolve_connect();
  (void)resolve_setsockopt();

  /*
   * Keep the Unix broker route only in this loaded process. Exec'd hooks,
   * commands, and stdio MCP servers cannot inherit the redirect capability.
   */
  if (unsetenv("HIVE_INTERVIEW_BROKER_PORT") != 0 ||
      unsetenv("HIVE_INTERVIEW_BROKER_SOCKET") != 0 ||
      unsetenv("LD_PRELOAD") != 0 || unsetenv("ANTHROPIC_AUTH_TOKEN") != 0 ||
      unsetenv("CLAUDE_CODE_OAUTH_TOKEN") != 0 ||
      unsetenv("CLAUDE_CODE_OAUTH_REFRESH_TOKEN") != 0 ||
      unsetenv("CLAUDE_CODE_OAUTH_SCOPES") != 0) {
    guard_failure();
  }
}
