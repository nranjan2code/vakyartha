FROM rust:1.99.1-bookworm@sha256:9181b56c2a21ab1d5e73cffe04fc762426d30aa7fac3c91141dd033f49a7fc8b

RUN rustup component add clippy

RUN apt-get update -qq \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
        build-essential \
        curl \
        file \
        libayatana-appindicator3-dev \
        librsvg2-dev \
        libssl-dev \
        libwebkit2gtk-4.1-dev \
        libxdo-dev \
        pkg-config \
        wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /work
