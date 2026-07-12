FROM debian:bookworm-slim

ARG TARGETARCH
ARG MISE_VERSION=2026.6.14

ENV MISE_DATA_DIR=/opt/mise/data \
    MISE_CACHE_DIR=/opt/mise/cache \
    MISE_STATE_DIR=/opt/mise/state \
    MISE_CONFIG_DIR=/opt/mise/config \
    MISE_GLOBAL_CONFIG_FILE=/opt/mise/global.toml \
    MISE_TASK_RUN_AUTO_INSTALL=false \
    PATH=/opt/mise/data/installs/node/24.18.0/bin:/opt/mise/data/shims:/usr/local/bin:${PATH}

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) mise_arch=x64 ;; \
      arm64) mise_arch=arm64 ;; \
      *) echo "Unsupported container architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    asset="mise-v${MISE_VERSION}-linux-${mise_arch}"; \
    curl --fail --location --silent --show-error \
      "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/${asset}" \
      --output "/tmp/${asset}"; \
    curl --fail --location --silent --show-error \
      "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/SHASUMS256.txt" \
      --output /tmp/SHASUMS256.txt; \
    grep "  \./${asset}$" /tmp/SHASUMS256.txt >/tmp/mise.sha256; \
    cd /tmp; \
    sha256sum --check mise.sha256; \
    install --mode 0755 "/tmp/${asset}" /usr/local/bin/mise; \
    rm -f "/tmp/${asset}" /tmp/SHASUMS256.txt /tmp/mise.sha256

WORKDIR /workspace

COPY mise.toml mise.lock ./

RUN mkdir -p "${MISE_CONFIG_DIR}" "${MISE_DATA_DIR}" "${MISE_CACHE_DIR}" "${MISE_STATE_DIR}" \
    && : >"${MISE_GLOBAL_CONFIG_FILE}" \
    && mise trust /workspace/mise.toml \
    && mise install --locked node \
    && mise exec node -- corepack prepare pnpm@10.34.5 --activate \
    && mise exec node -- corepack enable pnpm

EXPOSE 5173

CMD ["sh", "-lc", "mise run --skip-tools install && exec mise run --skip-tools dev"]
