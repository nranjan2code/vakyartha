#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
image_name=vakyartha-linux-rust-check:1.99.1

docker build \
  --file "$repo_root/scripts/linux-rust-check.Dockerfile" \
  --tag "$image_name" \
  "$repo_root/scripts"

docker run --rm \
  --volume "$repo_root:/work" \
  --volume vakyartha-linux-cargo-registry:/usr/local/cargo/registry \
  --volume vakyartha-linux-cargo-git:/usr/local/cargo/git \
  --volume vakyartha-linux-target:/work/src-tauri/target \
  --workdir /work \
  --env 'TAURI_CONFIG={"bundle":{"externalBin":[]}}' \
  "$image_name" \
  sh -eu -c '
    cargo test --locked --manifest-path src-tauri/Cargo.toml
    cargo clippy --locked --manifest-path src-tauri/Cargo.toml --lib --tests -- -D warnings
  '
