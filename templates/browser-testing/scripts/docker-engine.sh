#!/bin/sh
# No Coder agent or owner credentials run in this container. The only Docker
# listener is a socket on this workspace's private PVC, shared with its dev pod.
set -eu

routes=$(ip -4 route show default)
interface=$(printf '%s\n' "$routes" | awk '{for (i=1; i<NF; i++) if ($i == "dev") {print $(i+1); exit}}')
test -n "$interface" || { echo 'Docker: no default network interface' >&2; exit 1; }
links=$(ip link show dev "$interface")
mtu=$(printf '%s\n' "$links" | awk '{for (i=1; i<NF; i++) if ($i == "mtu") {print $(i+1); exit}}')
case "$mtu" in ''|*[!0-9]*) echo 'Docker: invalid network MTU' >&2; exit 1 ;; esac
test "$mtu" -ge 68 && test "$mtu" -le 65535

test -d /run/hive-docker
umask 077
printf '%s\n' '{"features":{"containerd-snapshotter":false}}' > /run/daemon.json
exec dockerd --config-file=/run/daemon.json --host=unix:///run/hive-docker/docker.sock \
  --storage-driver=overlay2 --group=1000 --mtu="$mtu" \
  --default-network-opt="bridge=com.docker.network.driver.mtu=$mtu"
