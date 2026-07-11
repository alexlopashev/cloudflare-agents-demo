#!/usr/bin/env fish

if not test -f mise.toml
    echo "Run bootstrap from the repository root." >&2
    return 1
end

set -gx REGRESSION_SURGEON_ROOT $PWD
if not set -q REGRESSION_SURGEON_USER_MISE_CONFIG
    if set -q MISE_CONFIG_DIR
        set -gx REGRESSION_SURGEON_USER_MISE_CONFIG "$MISE_CONFIG_DIR/config.toml"
    else if set -q XDG_CONFIG_HOME
        set -gx REGRESSION_SURGEON_USER_MISE_CONFIG "$XDG_CONFIG_HOME/mise/config.toml"
    else
        set -gx REGRESSION_SURGEON_USER_MISE_CONFIG "$HOME/.config/mise/config.toml"
    end
end
set -l user_mise_config $REGRESSION_SURGEON_USER_MISE_CONFIG
set -gx MISE_INSTALL_PATH "$PWD/.local/bin/mise"
set -gx MISE_DATA_DIR "$PWD/.local/share/mise"
set -gx MISE_CACHE_DIR "$PWD/.local/cache/mise"
set -gx MISE_STATE_DIR "$PWD/.local/state/mise"
set -gx MISE_GLOBAL_CONFIG_FILE "$PWD/.local/mise-global.toml"
set -gx MISE_CONFIG_DIR "$PWD/.local/config/mise"
if not set -q MISE_IGNORED_CONFIG_PATHS
    set -gx MISE_IGNORED_CONFIG_PATHS $user_mise_config
else if not string match -q "*:$user_mise_config:*" ":$MISE_IGNORED_CONFIG_PATHS:"
    set -gx MISE_IGNORED_CONFIG_PATHS "$user_mise_config:$MISE_IGNORED_CONFIG_PATHS"
end

if test "$REGRESSION_SURGEON_BOOTSTRAP_TEST" = "1"
    set -gx REGRESSION_SURGEON_MISE_ACTIVE fish
    return 0
end

sh scripts/bootstrap-core.sh; or return $status
$MISE_INSTALL_PATH activate fish | source
set -gx REGRESSION_SURGEON_MISE_ACTIVE fish
