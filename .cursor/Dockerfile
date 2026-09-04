FROM node:24.20.0-bookworm

ARG RUST_TOOLCHAIN=1.93.1
ARG WASM_PACK_VERSION=0.15.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        chromium \
        curl \
        fonts-noto-cjk \
        git \
        libssl-dev \
        pkg-config \
        procps \
        python3 \
    && rm -rf /var/lib/apt/lists/*

USER node
ENV CARGO_HOME=/home/node/.cargo \
    RUSTUP_HOME=/home/node/.rustup \
    PATH=/home/node/.cargo/bin:${PATH}

RUN set -eux; \
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup-init.sh; \
    sh /tmp/rustup-init.sh -y --profile minimal --default-toolchain "${RUST_TOOLCHAIN}"; \
    rm /tmp/rustup-init.sh; \
    rustup component add --toolchain "${RUST_TOOLCHAIN}" clippy rustfmt; \
    rustup target add --toolchain "${RUST_TOOLCHAIN}" wasm32-unknown-unknown; \
    cargo +"${RUST_TOOLCHAIN}" install wasm-pack --version "${WASM_PACK_VERSION}" --locked

WORKDIR /workspace
