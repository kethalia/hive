#define _GNU_SOURCE
#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <pthread.h>
#include <sys/socket.h>

// KasmVNC 1.4.0's WebUDP listener ignores -interface. This library is loaded
// only into the managed Xvnc process, never the desktop's applications.
static int (*original_bind)(int, const struct sockaddr *, socklen_t);
static pthread_once_t bind_once = PTHREAD_ONCE_INIT;

static void resolve_bind(void) {
  original_bind = dlsym(RTLD_NEXT, "bind");
}

int bind(int fd, const struct sockaddr *address, socklen_t length) {
  if (!address || length < sizeof(sa_family_t)) {
    errno = EINVAL;
    return -1;
  }
  if (address->sa_family == AF_INET) {
    if (length < sizeof(struct sockaddr_in)) {
      errno = EINVAL;
      return -1;
    }
    const struct sockaddr_in *ipv4 = (const struct sockaddr_in *)address;
    if ((ntohl(ipv4->sin_addr.s_addr) & 0xff000000U) != 0x7f000000U) {
      errno = EACCES;
      return -1;
    }
  } else if (address->sa_family == AF_INET6) {
    if (length < sizeof(struct sockaddr_in6)) {
      errno = EINVAL;
      return -1;
    }
    const struct sockaddr_in6 *ipv6 = (const struct sockaddr_in6 *)address;
    if (!IN6_IS_ADDR_LOOPBACK(&ipv6->sin6_addr)) {
      errno = EACCES;
      return -1;
    }
  }
  pthread_once(&bind_once, resolve_bind);
  if (!original_bind) {
    errno = ENOSYS;
    return -1;
  }
  return original_bind(fd, address, length);
}
