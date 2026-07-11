if not ("mise.toml" | path exists) {
  error make { msg: "Run activation from the repository root." }
}

$env.REGRESSION_SURGEON_ROOT = $env.PWD
if "REGRESSION_SURGEON_USER_MISE_CONFIG" not-in $env {
  let user_mise_config_dir = if "MISE_CONFIG_DIR" in $env {
    $env.MISE_CONFIG_DIR
  } else if "XDG_CONFIG_HOME" in $env {
    ($env.XDG_CONFIG_HOME | path join "mise")
  } else {
    ($env.HOME | path join ".config" "mise")
  }
  $env.REGRESSION_SURGEON_USER_MISE_CONFIG = ($user_mise_config_dir | path join "config.toml")
}
let user_mise_config = $env.REGRESSION_SURGEON_USER_MISE_CONFIG
$env.MISE_INSTALL_PATH = ($env.PWD | path join ".local" "bin" "mise")
$env.MISE_DATA_DIR = ($env.PWD | path join ".local" "share" "mise")
$env.MISE_CACHE_DIR = ($env.PWD | path join ".local" "cache" "mise")
$env.MISE_STATE_DIR = ($env.PWD | path join ".local" "state" "mise")
$env.MISE_GLOBAL_CONFIG_FILE = ($env.PWD | path join ".local" "mise-global.toml")
$env.MISE_CONFIG_DIR = ($env.PWD | path join ".local" "config" "mise")
$env.MISE_IGNORED_CONFIG_PATHS = if "MISE_IGNORED_CONFIG_PATHS" not-in $env {
  $user_mise_config
} else if ($env.MISE_IGNORED_CONFIG_PATHS | split row ":" | any { |path| $path == $user_mise_config }) {
  $env.MISE_IGNORED_CONFIG_PATHS
} else {
  ([$user_mise_config $env.MISE_IGNORED_CONFIG_PATHS] | str join ":")
}

if not ($env.MISE_INSTALL_PATH | path exists) {
  error make { msg: "The repository-local toolchain is missing; source scripts/bootstrap.nu first." }
}

$env.PATH = ($env.PATH | prepend ($env.MISE_DATA_DIR | path join "shims"))
$env.PATH = ($env.PATH | prepend ($env.MISE_INSTALL_PATH | path dirname))
$env.REGRESSION_SURGEON_MISE_ACTIVE = "nu"
