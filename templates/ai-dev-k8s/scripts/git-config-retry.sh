#!/bin/bash
# Coder runs startup and module scripts concurrently; another writer may hold
# Git's global-config lock briefly. Retry only lock contention, never delete it.
configure_git_global() {
  local attempt delay=1 output status
  for attempt in 1 2 3 4 5 6; do
    if output=$(LC_ALL=C git config --global "$@" 2>&1); then
      return 0
    else
      status=$?
    fi
    if [[ "$output" != *"could not lock config file"* || "$output" != *"File exists"* ]]; then
      printf '%s\n' "$output" >&2
      return "$status"
    fi
    if [ "$attempt" -eq 6 ]; then
      printf '%s\n' "$output" >&2
      return "$status"
    fi
    sleep "$delay"
    delay=$((delay * 2))
  done
}

