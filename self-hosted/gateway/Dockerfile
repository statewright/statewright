FROM rust:1.87-bookworm AS builder

WORKDIR /build

# Copy workspace Cargo files first for dependency caching
COPY Cargo.toml Cargo.lock ./
COPY crates/engine/Cargo.toml crates/engine/Cargo.toml
COPY crates/agent/Cargo.toml crates/agent/Cargo.toml
COPY crates/mcp-gateway/Cargo.toml crates/mcp-gateway/Cargo.toml
COPY crates/demo/Cargo.toml crates/demo/Cargo.toml
COPY crates/tui/Cargo.toml crates/tui/Cargo.toml

# Create stub source files for dependency pre-build
RUN mkdir -p crates/engine/src crates/agent/src crates/mcp-gateway/src crates/demo/src crates/tui/src \
    && echo "pub fn stub() {}" > crates/engine/src/lib.rs \
    && echo "pub fn stub() {}" > crates/agent/src/lib.rs \
    && echo "pub fn stub() {}" > crates/mcp-gateway/src/lib.rs \
    && echo "fn main() {}" > crates/mcp-gateway/src/main.rs \
    && echo "pub fn stub() {}" > crates/demo/src/lib.rs \
    && echo "fn main() {}" > crates/demo/src/main.rs \
    && echo "fn main() {}" > crates/tui/src/main.rs

# Pre-build dependencies
RUN cargo build --release -p statewright-mcp-gateway 2>/dev/null || true

# Copy actual source
COPY crates/ crates/

# Touch source files to invalidate stubs
RUN touch crates/engine/src/lib.rs crates/agent/src/lib.rs crates/mcp-gateway/src/lib.rs crates/mcp-gateway/src/main.rs

# Build the gateway binary
RUN cargo build --release -p statewright-mcp-gateway

# --- Runtime ---
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/target/release/statewright-gateway /usr/local/bin/statewright-gateway

EXPOSE 3001

CMD ["statewright-gateway", "--remote", "--pb-url", "http://pocketbase:8090"]
