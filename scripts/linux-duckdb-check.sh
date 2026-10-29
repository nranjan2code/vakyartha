#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
platform=${VAK_LINUX_DUCKDB_PLATFORM:-linux/arm64}
image_name=vakyartha-linux-duckdb-check:2.0.0-r.1

docker build \
  --platform "$platform" \
  --file "$repo_root/scripts/linux-duckdb-check.Dockerfile" \
  --tag "$image_name" \
  "$repo_root"

docker run --rm --platform "$platform" "$image_name"
