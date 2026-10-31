#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
test "$(git -C "$repo_root/../sandbox" rev-parse HEAD)" = 698f879c8e40024687189b166a0695c8a43183f1
test -z "$(git -C "$repo_root/../sandbox" status --porcelain)"
image_name=vakyartha-linux-rust-check:1.99.1
docker build --file "$repo_root/scripts/linux-rust-check.Dockerfile" --tag "$image_name" "$repo_root/scripts"
docker run --rm --volume vakyartha-linux-node26:/runtime \
  node:26.13.0-bookworm@sha256:fa52d1669505e29b58c042875b1d65c229e0787a3610fd52869b22b68e480853 \
  cp /usr/local/bin/node /runtime/node
docker run --rm \
  --volume "$repo_root:/work" \
  --volume "$repo_root/../sandbox:/sandbox:ro" \
  --volume vak-sandbox-linux-target:/sandbox-target \
  --volume vakyartha-linux-cargo-registry:/usr/local/cargo/registry \
  --volume vakyartha-linux-cargo-git:/usr/local/cargo/git \
  --volume vakyartha-linux-target:/work/src-tauri/target \
  --volume vakyartha-linux-node26:/runtime:ro \
  --workdir /work \
  --env 'TAURI_CONFIG={"bundle":{"externalBin":[]}}' \
  --env VAK_TEST_WORKER_HELPER=/sandbox-target/debug/vaksb \
  --env VAK_TEST_WORKER_NODE=/runtime/node \
  "$image_name" sh -eu -c '
    CARGO_TARGET_DIR=/sandbox-target cargo build --locked --manifest-path /sandbox/Cargo.toml -p vak-sandbox-ctl
    cargo test --locked --manifest-path src-tauri/Cargo.toml --lib -- --include-ignored --test-threads=1
    cargo clippy --locked --manifest-path src-tauri/Cargo.toml --lib --tests -- -D warnings
  '
