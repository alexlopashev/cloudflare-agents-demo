import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** @param {string} path */
function readRepo(path) {
  return readFileSync(join(repoRoot, path), "utf8");
}

/** @param {unknown} error */
function isMissingCommand(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** @param {Record<string, string>} [overrides] */
function cleanEnvironment(overrides = {}) {
  const environment = { ...process.env };
  for (const key of [
    "MISE_INSTALL_PATH",
    "MISE_DATA_DIR",
    "MISE_CACHE_DIR",
    "MISE_STATE_DIR",
    "MISE_CONFIG_DIR",
    "MISE_GLOBAL_CONFIG_FILE",
    "MISE_IGNORED_CONFIG_PATHS",
    "REGRESSION_SURGEON_ROOT",
    "REGRESSION_SURGEON_USER_MISE_CONFIG",
    "REGRESSION_SURGEON_ASSUME_YES",
    "REGRESSION_SURGEON_ASSUME_NO",
  ]) {
    delete environment[key];
  }
  return { ...environment, ...overrides };
}

test("foundation exposes the committed developer entrypoints", () => {
  for (const path of [
    "mise.toml",
    "pnpm-workspace.yaml",
    "package.json",
    "scripts/bootstrap",
    "scripts/bootstrap.fish",
    "scripts/bootstrap.nu",
    "scripts/bootstrap-core.sh",
    "scripts/activate",
    "scripts/activate.fish",
    "scripts/activate.nu",
    "scripts/teardown",
    "scripts/doctor.mjs",
    ".github/workflows/ci.yml",
  ]) {
    assert.doesNotThrow(() => readRepo(path), `missing ${path}`);
  }
});

test("mise pins the agreed runtime and external tools", () => {
  const config = readRepo("mise.toml");
  const packageManifest = JSON.parse(readRepo("package.json"));
  const bootstrap = readRepo("scripts/bootstrap-core.sh");

  for (const expected of [
    'node = "24.18.0"',
    'version = "4.110.0"',
    'gh = "2.96.0"',
    'version = "0.10.3"',
    '"github:nushell/nushell" = "0.113.1"',
    "lockfile = true",
  ]) {
    assert.match(config, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  assert.equal(packageManifest.packageManager, "pnpm@10.34.5");
  assert.match(bootstrap, /corepack enable pnpm/);
  assert.match(bootstrap, /corepack prepare pnpm@10\.34\.5 --activate/);
});

test("shell syntax validation cannot invoke the real bootstrap", () => {
  const syntaxGate = readRepo("scripts/lint-shells.mjs");

  assert.match(syntaxGate, /REGRESSION_SURGEON_BOOTSTRAP_TEST/);
});

test("mise doctor task invokes the repository doctor script", () => {
  assert.match(readRepo("mise.toml"), /\[tasks\.doctor\][\s\S]*run = "pnpm run doctor"/);
});

test("CI covers every supported operating-system and architecture pair", () => {
  const workflow = readRepo(".github/workflows/ci.yml");

  for (const runner of ["ubuntu-24.04", "ubuntu-24.04-arm", "macos-15", "macos-15-intel"]) {
    assert.match(workflow, new RegExp(`- ${runner.replaceAll(".", "\\.")}`));
  }
});

for (const shell of ["sh", "bash", "zsh"]) {
  test(`${shell} bootstrap activates only the current shell and preserves profiles`, () => {
    const home = mkdtempSync(join(tmpdir(), `regression-surgeon-${shell}-`));
    const sentinel = `unchanged-${shell}\n`;

    for (const profile of [".profile", ".bashrc", ".zshrc"]) {
      writeFileSync(join(home, profile), sentinel);
    }

    const output = execFileSync(
      shell,
      [
        "-c",
        [
          `cd ${JSON.stringify(repoRoot)}`,
          `export HOME=${JSON.stringify(home)}`,
          "export REGRESSION_SURGEON_BOOTSTRAP_TEST=1",
          ". ./scripts/bootstrap",
          'printf "%s|%s" "$REGRESSION_SURGEON_MISE_ACTIVE" "$MISE_IGNORED_CONFIG_PATHS"',
        ].join("; "),
      ],
      { encoding: "utf8", env: cleanEnvironment() },
    );

    assert.equal(output, `${shell}|${join(home, ".config/mise/config.toml")}`);

    for (const profile of [".profile", ".bashrc", ".zshrc"]) {
      assert.equal(readFileSync(join(home, profile), "utf8"), sentinel);
    }
  });
}

test("bootstrap is idempotent in one active shell", () => {
  const home = mkdtempSync(join(tmpdir(), "regression-surgeon-idempotent-"));
  const command = [
    `cd ${JSON.stringify(repoRoot)}`,
    `export HOME=${JSON.stringify(home)}`,
    "export REGRESSION_SURGEON_BOOTSTRAP_TEST=1",
    ". ./scripts/bootstrap",
    ". ./scripts/bootstrap",
    'printf "%s|%s" "$REGRESSION_SURGEON_MISE_ACTIVE" "$MISE_IGNORED_CONFIG_PATHS"',
  ].join("; ");

  assert.equal(
    execFileSync("bash", ["-c", command], { encoding: "utf8", env: cleanEnvironment() }),
    `bash|${join(home, ".config/mise/config.toml")}`,
  );
});

test("plain sh activation uses repository shims without an unsupported mise hook", () => {
  const root = mkdtempSync(join(tmpdir(), "regression-surgeon-sh-activate-"));
  const scripts = join(root, "scripts");
  const miseBin = join(root, ".local/bin/mise");
  const nodeShim = join(root, ".local/share/mise/shims/node");
  const log = join(root, "mise-activate.log");
  mkdirSync(scripts);
  mkdirSync(dirname(miseBin), { recursive: true });
  mkdirSync(dirname(nodeShim), { recursive: true });
  writeFileSync(join(root, "mise.toml"), 'min_version = "2026.6.14"\n');
  copyFileSync(join(repoRoot, "scripts/activate"), join(scripts, "activate"));
  writeFileSync(
    miseBin,
    ["#!/bin/sh", `printf '%s\\n' "$*" >>${JSON.stringify(log)}`, "exit 2"].join("\n"),
  );
  writeFileSync(nodeShim, "#!/bin/sh\nexit 0\n");
  chmodSync(miseBin, 0o755);
  chmodSync(nodeShim, 0o755);

  const output = execFileSync(
    "sh",
    [
      "-c",
      `. ./scripts/activate; printf '%s|%s' "$REGRESSION_SURGEON_MISE_ACTIVE" "$(command -v node)"`,
    ],
    { cwd: root, encoding: "utf8", env: cleanEnvironment() },
  );

  assert.equal(output, `sh|${realpathSync(nodeShim)}`);
  assert.equal(existsSync(log), false);
});

test("declining mise installation wins over approval and leaves no repository-local state", () => {
  const root = mkdtempSync(join(tmpdir(), "regression-surgeon-decline-"));
  writeFileSync(join(root, "mise.toml"), 'min_version = "2026.6.14"\n');

  assert.throws(() =>
    execFileSync("sh", [join(repoRoot, "scripts/bootstrap-core.sh")], {
      cwd: root,
      env: cleanEnvironment({
        REGRESSION_SURGEON_ASSUME_YES: "1",
        REGRESSION_SURGEON_ASSUME_NO: "1",
      }),
      stdio: "pipe",
    }),
  );
  assert.equal(existsSync(join(root, ".local")), false);
});

for (const [name, operatingSystem, architecture] of [
  ["operating system", "Windows_NT", "x86_64"],
  ["architecture", "Darwin", "riscv64"],
]) {
  test(`bootstrap rejects an unsupported ${name} before repository mutation`, () => {
    const root = mkdtempSync(join(tmpdir(), "regression-surgeon-unsupported-"));
    const fixtureBin = join(root, "fixture-bin");
    const externalMise = join(root, "external/mise");
    mkdirSync(fixtureBin);
    mkdirSync(dirname(externalMise), { recursive: true });
    writeFileSync(join(root, "mise.toml"), 'min_version = "2026.6.14"\n');
    writeFileSync(
      join(fixtureBin, "uname"),
      [
        "#!/bin/sh",
        `if [ "$1" = "-s" ]; then printf '%s\\n' ${JSON.stringify(operatingSystem)}; else printf '%s\\n' ${JSON.stringify(architecture)}; fi`,
      ].join("\n"),
    );
    writeFileSync(externalMise, "#!/bin/sh\nexit 0\n");
    chmodSync(join(fixtureBin, "uname"), 0o755);
    chmodSync(externalMise, 0o755);

    assert.throws(() =>
      execFileSync("sh", [join(repoRoot, "scripts/bootstrap-core.sh")], {
        cwd: root,
        env: cleanEnvironment({
          PATH: `${fixtureBin}:${process.env.PATH}`,
          MISE_INSTALL_PATH: externalMise,
          REGRESSION_SURGEON_ASSUME_YES: "1",
        }),
        stdio: "pipe",
      }),
    );
    assert.equal(existsSync(join(root, ".local")), false);
  });
}

test("approved bootstrap delegates every pinned setup step through repository-local mise", () => {
  const root = mkdtempSync(join(tmpdir(), "regression-surgeon-approved-"));
  const miseBin = join(root, ".local/bin/mise");
  const log = join(root, "mise-calls.log");
  mkdirSync(dirname(miseBin), { recursive: true });
  writeFileSync(join(root, "mise.toml"), 'min_version = "2026.6.14"\n');
  writeFileSync(
    miseBin,
    [
      "#!/bin/sh",
      'printf \'ignored=%s\\n\' "$MISE_IGNORED_CONFIG_PATHS" >>"$REGRESSION_SURGEON_TEST_LOG"',
      'printf \'%s\\n\' "$*" >>"$REGRESSION_SURGEON_TEST_LOG"',
    ].join("\n"),
  );
  chmodSync(miseBin, 0o755);

  execFileSync("sh", [join(repoRoot, "scripts/bootstrap-core.sh")], {
    cwd: root,
    env: cleanEnvironment({
      REGRESSION_SURGEON_ASSUME_YES: "1",
      REGRESSION_SURGEON_TEST_LOG: log,
    }),
  });

  const calls = readFileSync(log, "utf8");
  assert.equal(existsSync(join(root, ".local/mise-global.toml")), true);
  assert.match(calls, /ignored=.*\.config\/mise\/config\.toml/);
  assert.match(calls, /trust .*mise\.toml/);
  assert.match(calls, /^install$/m);
  assert.match(calls, /exec node -- corepack prepare pnpm@10\.34\.5 --activate/);
  assert.match(calls, /exec node -- corepack enable pnpm/);
  assert.match(calls, /exec -- pnpm install --frozen-lockfile/);
  assert.match(calls, /exec -- pnpm check/);
});

test("teardown removes only project-owned runtime paths", () => {
  const root = mkdtempSync(join(tmpdir(), "regression-surgeon-teardown-"));
  const external = mkdtempSync(join(tmpdir(), "regression-surgeon-external-"));
  writeFileSync(join(root, "mise.toml"), 'min_version = "2026.6.14"\n');
  mkdirSync(join(root, ".wrangler/state"), { recursive: true });
  mkdirSync(join(root, ".local/run"), { recursive: true });
  writeFileSync(join(external, "sentinel"), "preserve\n");

  execFileSync("sh", [join(repoRoot, "scripts/teardown")], {
    cwd: root,
    encoding: "utf8",
  });
  execFileSync("sh", [join(repoRoot, "scripts/teardown")], {
    cwd: root,
    encoding: "utf8",
  });

  assert.equal(existsSync(join(root, ".wrangler/state")), false);
  assert.equal(existsSync(join(root, ".local/run")), false);
  assert.equal(readFileSync(join(external, "sentinel"), "utf8"), "preserve\n");
});

test("Nu bootstrap activates only the current shell and preserves config", (context) => {
  try {
    execFileSync("nu", ["--version"], { stdio: "ignore" });
  } catch (error) {
    if (isMissingCommand(error)) {
      context.skip("Nu is not installed on this host; CI supplies the Nu contract gate.");
      return;
    }
    throw error;
  }

  const home = mkdtempSync(join(tmpdir(), "regression-surgeon-nu-"));
  const configDir = join(home, ".config/nushell");
  mkdirSync(configDir, { recursive: true });
  const config = join(configDir, "config.nu");
  writeFileSync(config, "# unchanged\n");

  const command = [
    `cd ${JSON.stringify(repoRoot)}`,
    `$env.HOME = ${JSON.stringify(home)}`,
    '$env.REGRESSION_SURGEON_BOOTSTRAP_TEST = "1"',
    "source scripts/bootstrap.nu",
    'print -n $"($env.REGRESSION_SURGEON_MISE_ACTIVE)|($env.MISE_IGNORED_CONFIG_PATHS)"',
  ].join("; ");
  const output = execFileSync("nu", ["--no-config-file", "--commands", command], {
    encoding: "utf8",
    env: cleanEnvironment(),
  });

  assert.equal(output, `nu|${join(home, ".config/mise/config.toml")}`);
  assert.equal(readFileSync(config, "utf8"), "# unchanged\n");
});

test("Nu teardown is idempotent and forwards an empty argument list", () => {
  const root = mkdtempSync(join(tmpdir(), "regression-surgeon-nu-teardown-"));
  const scripts = join(root, "scripts");
  mkdirSync(join(root, ".local/run"), { recursive: true });
  mkdirSync(scripts);
  writeFileSync(join(root, "mise.toml"), 'min_version = "2026.6.14"\n');
  copyFileSync(join(repoRoot, "scripts/teardown"), join(scripts, "teardown"));
  copyFileSync(join(repoRoot, "scripts/teardown.nu"), join(scripts, "teardown.nu"));
  chmodSync(join(scripts, "teardown"), 0o755);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    execFileSync("nu", ["--no-config-file", join(scripts, "teardown.nu")], {
      cwd: root,
      encoding: "utf8",
    });
  }

  assert.equal(existsSync(join(root, ".local/run")), false);
});

test("Fish bootstrap activates only the current shell and preserves config", (context) => {
  try {
    execFileSync("fish", ["--version"], { stdio: "ignore" });
  } catch (error) {
    if (isMissingCommand(error)) {
      context.skip("Fish is not installed on this host; CI supplies the Fish contract gate.");
      return;
    }
    throw error;
  }

  const home = mkdtempSync(join(tmpdir(), "regression-surgeon-fish-"));
  const configDir = join(home, ".config/fish");
  mkdirSync(configDir, { recursive: true });
  const config = join(configDir, "config.fish");
  writeFileSync(config, "# unchanged\n");

  const command = [
    `cd ${JSON.stringify(repoRoot)}`,
    `set -gx HOME ${JSON.stringify(home)}`,
    "set -gx REGRESSION_SURGEON_BOOTSTRAP_TEST 1",
    "source scripts/bootstrap.fish",
    'printf "%s|%s" "$REGRESSION_SURGEON_MISE_ACTIVE" "$MISE_IGNORED_CONFIG_PATHS"',
  ].join("; ");
  const output = execFileSync("fish", ["--no-config", "--command", command], {
    encoding: "utf8",
    env: cleanEnvironment(),
  });

  assert.equal(output, `fish|${join(home, ".config/mise/config.toml")}`);
  assert.equal(readFileSync(config, "utf8"), "# unchanged\n");
});
