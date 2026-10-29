#!/bin/sh
# Runs only in the Coder provisioner, which injects the actual workspace build ID.
# Never read a ticket, workspace file, owner token, or agent-supplied identifier.
set -eu
build_id=${CODER_WORKSPACE_BUILD_ID:-}
if [ "${#build_id}" -ne 36 ] || ! printf '%s' "$build_id" | LC_ALL=C grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'; then
  printf '%s\n' 'Coder provisioner build identity is unavailable.' >&2
  exit 1
fi
printf '{"build_id":"%s"}\n' "$build_id"
