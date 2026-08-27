#!/bin/sh
set -eu

umask 077

image_home="${HIVE_IMAGE_HOME:-/home/coder}"
target_home="${HIVE_TARGET_HOME:-/target}"
staging_directory="$target_home/.hive-image-seed-staging"
staging_ready="$staging_directory/.hive-stage-complete"
in_progress_marker="$target_home/.hive-image-seed-in-progress"
complete_marker="$target_home/.hive-image-seed-complete"

warn_and_preserve() {
  printf '[warn] %s\n' "$1" >&2
  exit 0
}

write_marker() {
  marker=$1
  if [ -L "$marker" ] || { [ -e "$marker" ] && [ ! -f "$marker" ]; }; then
    printf '[error] refusing to replace unsafe home-seed marker: %s\n' "$marker" >&2
    return 1
  fi
  printf 'hive technical interview home seed v1\n' > "$marker"
  chmod 600 "$marker"
}

if [ -L "$target_home" ] || [ ! -d "$target_home" ]; then
  printf '[error] interview home target is not a local directory: %s\n' "$target_home" >&2
  exit 1
fi
if [ -L "$image_home" ] || [ ! -d "$image_home" ]; then
  printf '[error] image home source is not a local directory: %s\n' "$image_home" >&2
  exit 1
fi

for marker in "$complete_marker" "$in_progress_marker"; do
  if [ -L "$marker" ] || { [ -e "$marker" ] && [ ! -f "$marker" ]; }; then
    warn_and_preserve "Unsafe home-seed marker was preserved: $marker"
  fi
done
if [ -f "$complete_marker" ]; then
  printf '[skip] image home was already seeded\n'
  exit 0
fi
if [ -L "$staging_directory" ] \
  || { [ -e "$staging_directory" ] && [ ! -d "$staging_directory" ]; }; then
  warn_and_preserve "Unsafe home-seed staging path was preserved: $staging_directory"
fi

existing_payload="$(
  find "$target_home" -mindepth 1 -maxdepth 1 \
    ! -name lost+found \
    ! -name .hive-image-seed-staging \
    ! -name .hive-image-seed-in-progress \
    ! -name .hive-image-seed-complete \
    -print -quit
)"

if [ -f "$in_progress_marker" ] && [ ! -e "$staging_directory" ]; then
  if [ -n "$existing_payload" ]; then
    write_marker "$complete_marker"
    rm -f -- "$in_progress_marker"
    printf '[ok] completed interrupted image-home promotion\n'
    exit 0
  fi
  rm -f -- "$in_progress_marker"
fi

if [ ! -f "$in_progress_marker" ] && [ -n "$existing_payload" ]; then
  printf '[skip] preserving existing workspace home; image seed skipped\n'
  exit 0
fi

if [ -d "$staging_directory" ] && { [ -L "$staging_ready" ] || [ ! -f "$staging_ready" ]; }; then
  if [ -n "$existing_payload" ] || [ -f "$in_progress_marker" ]; then
    warn_and_preserve "Incomplete home-seed staging was preserved because workspace data exists"
  fi
  rm -rf -- "$staging_directory"
fi

if [ ! -d "$staging_directory" ]; then
  mkdir -- "$staging_directory"
  cp -R --no-preserve=ownership,timestamps "$image_home/." "$staging_directory/"
  : > "$staging_ready"
  chmod 600 "$staging_ready"
fi

if [ ! -f "$in_progress_marker" ]; then
  write_marker "$in_progress_marker"
fi

find "$staging_directory" -mindepth 1 -maxdepth 1 ! -name .hive-stage-complete \
  -exec sh -eu -c '
    target=$1
    shift
    for source do
      name=${source##*/}
      destination=$target/$name
      if [ -e "$destination" ] || [ -L "$destination" ]; then
        printf "[warn] preserving existing home entry during seed recovery: %s\n" \
          "$destination" >&2
      else
        mv -T -- "$source" "$destination"
      fi
    done
  ' sh "$target_home" {} +

rm -rf -- "$staging_directory"
write_marker "$complete_marker"
rm -f -- "$in_progress_marker"
printf '[ok] image home seed complete\n'
