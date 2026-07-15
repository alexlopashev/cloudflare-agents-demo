#!/bin/sh

set -eu

if [ ! -f "mise.toml" ]; then
  printf '%s\n' "Run bootstrap from the repository root." >&2
  exit 1
fi

operating_system=$(uname -s)
architecture=$(uname -m)
case "$operating_system" in
  Darwin | Linux) ;;
  *)
    printf '%s\n' "Unsupported operating system: $operating_system (expected macOS or Linux)." >&2
    exit 1
    ;;
esac
case "$architecture" in
  arm64 | aarch64 | x86_64 | amd64) ;;
  *)
    printf '%s\n' "Unsupported architecture: $architecture (expected ARM64 or x64)." >&2
    exit 1
    ;;
esac
unset operating_system architecture

root=$PWD
if [ -z "${REGRESSION_SURGEON_USER_MISE_CONFIG:-}" ]; then
  if [ -n "${MISE_CONFIG_DIR:-}" ]; then
    REGRESSION_SURGEON_USER_MISE_CONFIG="$MISE_CONFIG_DIR/config.toml"
  elif [ -n "${XDG_CONFIG_HOME:-}" ]; then
    REGRESSION_SURGEON_USER_MISE_CONFIG="$XDG_CONFIG_HOME/mise/config.toml"
  else
    REGRESSION_SURGEON_USER_MISE_CONFIG="$HOME/.config/mise/config.toml"
  fi
fi
: "${MISE_INSTALL_PATH:=$root/.local/bin/mise}"
: "${MISE_DATA_DIR:=$root/.local/share/mise}"
: "${MISE_CACHE_DIR:=$root/.local/cache/mise}"
: "${MISE_STATE_DIR:=$root/.local/state/mise}"
: "${MISE_GLOBAL_CONFIG_FILE:=$root/.local/mise-global.toml}"
MISE_CONFIG_FILE="$root/mise.toml"
MISE_CEILING_PATHS=$(dirname "$root")
MISE_CONFIG_DIR="$root/.local/config/mise"
case ":${MISE_IGNORED_CONFIG_PATHS:-}:" in
  *":$REGRESSION_SURGEON_USER_MISE_CONFIG:"*) ;;
  *) MISE_IGNORED_CONFIG_PATHS="$REGRESSION_SURGEON_USER_MISE_CONFIG${MISE_IGNORED_CONFIG_PATHS:+:$MISE_IGNORED_CONFIG_PATHS}" ;;
esac
export MISE_INSTALL_PATH MISE_DATA_DIR MISE_CACHE_DIR MISE_STATE_DIR MISE_GLOBAL_CONFIG_FILE MISE_CONFIG_FILE MISE_CEILING_PATHS
export MISE_CONFIG_DIR MISE_IGNORED_CONFIG_PATHS

confirm() {
  prompt=$1

  if [ "${REGRESSION_SURGEON_ASSUME_NO:-0}" = "1" ]; then
    return 1
  fi
  if [ "${REGRESSION_SURGEON_ASSUME_YES:-0}" = "1" ]; then
    return 0
  fi
  if [ ! -r /dev/tty ]; then
    printf '%s\n' "$prompt requires an interactive terminal." >&2
    return 1
  fi

  printf '%s [Y/n] ' "$prompt" >/dev/tty
  old_tty=$(stty -g </dev/tty)
  trap 'stty "$old_tty" </dev/tty 2>/dev/null || true' EXIT HUP INT TERM
  stty -icanon min 1 time 0 -echo </dev/tty
  answer=$(dd bs=1 count=1 2>/dev/null </dev/tty || true)
  stty "$old_tty" </dev/tty
  trap - EXIT HUP INT TERM
  printf '\n' >/dev/tty

  case "$answer" in
    "" | y | Y) return 0 ;;
    *) return 1 ;;
  esac
}

if [ ! -x "$MISE_INSTALL_PATH" ]; then
  if ! confirm "Install the repository-local mise toolchain?"; then
    printf '%s\n' "mise installation declined." >&2
    exit 1
  fi
  mkdir -p "$(dirname "$MISE_INSTALL_PATH")" "$MISE_DATA_DIR" "$MISE_CACHE_DIR" "$MISE_STATE_DIR"
  curl -fsSL https://mise.run | MISE_INSTALL_PATH="$MISE_INSTALL_PATH" sh
fi

# An existing empty file is required; otherwise mise falls back to the user's global config.
mkdir -p "$(dirname "$MISE_GLOBAL_CONFIG_FILE")"
if [ ! -e "$MISE_GLOBAL_CONFIG_FILE" ]; then
  : >"$MISE_GLOBAL_CONFIG_FILE"
fi

if confirm "Trust this repository's mise configuration?"; then
  "$MISE_INSTALL_PATH" trust "$root/mise.toml"
else
  printf '%s\n' "Repository trust declined." >&2
  exit 1
fi

if confirm "Install the pinned development tools?"; then
  "$MISE_INSTALL_PATH" install --locked node wrangler gh shellcheck shfmt actionlint github:nushell/nushell colima docker-cli docker-compose
  "$MISE_INSTALL_PATH" exec node -- corepack prepare pnpm@10.34.5 --activate
  "$MISE_INSTALL_PATH" exec node -- corepack enable pnpm
else
  printf '%s\n' "Tool installation declined." >&2
  exit 1
fi

if confirm "Install locked JavaScript dependencies?"; then
  "$MISE_INSTALL_PATH" exec -- pnpm install --frozen-lockfile
else
  printf '%s\n' "Dependency installation declined." >&2
  exit 1
fi

if confirm "Apply repository-local D1 migrations?"; then
  "$MISE_INSTALL_PATH" exec -- pnpm db:migrate:local
fi

if confirm "Load deterministic local fixtures?"; then
  "$MISE_INSTALL_PATH" exec -- pnpm scenario:reseed
fi

if confirm "Run the build and complete local verification suite now?"; then
  "$MISE_INSTALL_PATH" exec -- pnpm check
  "$MISE_INSTALL_PATH" exec -- pnpm build
  "$MISE_INSTALL_PATH" exec -- pnpm e2e
fi
