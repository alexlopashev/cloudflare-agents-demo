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
const projectName = "regression-surgeon";
const profileName = "polylane-take-home";

/** @param {string} path */
function readRepo(path) {
  return readFileSync(join(repoRoot, path), "utf8");
}

/** @param {string} root */
function createFakeRuntime(root) {
  const bin = join(root, "fixture-bin");
  const log = join(root, "runtime.log");
  const state = join(root, "colima-running");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "colima"),
    [
      "#!/bin/sh",
      'printf \'colima|%s\\n\' "$*" >>"$REGRESSION_SURGEON_TEST_LOG"',
      'case "$1" in',
      '  status) test -f "$REGRESSION_SURGEON_TEST_COLIMA_STATE" ;;',
      '  start) mkdir -p "$COLIMA_HOME/polylane-take-home"; : >"$REGRESSION_SURGEON_TEST_COLIMA_STATE" ;;',
      '  stop) rm -f "$REGRESSION_SURGEON_TEST_COLIMA_STATE" ;;',
      '  delete) rm -f "$REGRESSION_SURGEON_TEST_COLIMA_STATE"; rm -rf "$COLIMA_HOME/polylane-take-home" ;;',
      "  *) exit 2 ;;",
      "esac",
    ].join("\n"),
  );
  writeFileSync(
    join(bin, "docker-cli-plugin-docker-compose"),
    [
      "#!/bin/sh",
      'printf \'compose|host=%s|%s\\n\' "$DOCKER_HOST" "$*" >>"$REGRESSION_SURGEON_TEST_LOG"',
      `test "\${REGRESSION_SURGEON_TEST_COMPOSE_FAIL:-0}" != "1"`,
    ].join("\n"),
  );
  chmodSync(join(bin, "colima"), 0o755);
  chmodSync(join(bin, "docker-cli-plugin-docker-compose"), 0o755);
  return { bin, log, state };
}

/** @param {string} root @param {ReturnType<typeof createFakeRuntime>} runtime */
function runtimeEnvironment(root, runtime) {
  return {
    ...process.env,
    COLIMA_HOME: join(root, "colima-home"),
    HOME: join(root, "home"),
    PATH: `${runtime.bin}:${process.env.PATH ?? ""}`,
    REGRESSION_SURGEON_TEST_COLIMA_STATE: runtime.state,
    REGRESSION_SURGEON_TEST_LOG: runtime.log,
  };
}

/** @param {string} root */
function createProject(root) {
  writeFileSync(join(root, "mise.toml"), 'min_version = "2026.6.14"\n');
  writeFileSync(join(root, "compose.yaml"), "services: {}\n");
}

/** @param {string} root @param {string} operation @param {NodeJS.ProcessEnv} env */
function runContainer(root, operation, env) {
  execFileSync(process.execPath, [join(repoRoot, "scripts/container.mjs"), operation], {
    cwd: root,
    env,
    stdio: "pipe",
  });
}

test("optional container artifacts define one Linux service over isolated volumes", () => {
  for (const path of ["Containerfile", "compose.yaml", ".dockerignore", "scripts/container.mjs"]) {
    assert.doesNotThrow(() => readRepo(path), `missing ${path}`);
  }

  const containerfile = readRepo("Containerfile");
  const compose = readRepo("compose.yaml");
  const dockerignore = readRepo(".dockerignore");
  assert.match(containerfile, /MISE_VERSION=2026\.6\.14/);
  assert.match(containerfile, /mise install --locked node/);
  assert.match(containerfile, /PATH=\/opt\/mise\/data\/installs\/node\/24\.18\.0\/bin:/);
  const checksumSelector = 'grep "  \\./$' + '{asset}$"';
  assert.equal(containerfile.includes(checksumSelector), true);
  assert.match(compose, /mise run --skip-tools dev/);
  assert.match(compose, /127\.0\.0\.1:5173:5173/);
  assert.match(compose, /\/workspace\/node_modules/);
  assert.match(compose, /\/workspace\/\.wrangler/);
  assert.match(compose, /\/workspace\/\.local/);
  assert.match(dockerignore, /^node_modules\/$/m);
  assert.doesNotMatch(compose, /node_modules:\/workspace\/node_modules/);
});

test("pinned Compose resolves one service that runs the canonical dev task", () => {
  const output = execFileSync(
    "docker-cli-plugin-docker-compose",
    ["--file", "compose.yaml", "config", "--format", "json"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  const model =
    /** @type {{ services: Record<string, { command: string[], volumes: Array<{ type: string, target: string }> }> }} */ (
      JSON.parse(output)
    );

  assert.deepEqual(Object.keys(model.services), ["app"]);
  const app = model.services.app;
  assert.ok(app);
  assert.deepEqual(app.command, [
    "sh",
    "-lc",
    "mise run --skip-tools install && exec mise run --skip-tools dev",
  ]);
  const mounts = app.volumes;
  assert.equal(mounts.filter((mount) => mount.type === "bind").length, 1);
  assert.equal(
    mounts.some((mount) => mount.type === "bind" && mount.target === "/workspace/node_modules"),
    false,
  );
  for (const target of ["/workspace/node_modules", "/workspace/.wrangler", "/workspace/.local"]) {
    assert.equal(
      mounts.some((mount) => mount.type === "volume" && mount.target === target),
      true,
    );
  }
});

test("container up is repeatable and down stops only a profile it started", () => {
  const root = mkdtempSync(join(tmpdir(), "regression-surgeon-container-owned-"));
  createProject(root);
  const runtime = createFakeRuntime(root);
  const env = runtimeEnvironment(root, runtime);

  runContainer(root, "up", env);
  runContainer(root, "up", env);

  const markerPath = join(root, ".local/run/container.json");
  assert.deepEqual(JSON.parse(readFileSync(markerPath, "utf8")), {
    createdProfile: true,
    profile: profileName,
    project: projectName,
    startedProfile: true,
  });
  let calls = readFileSync(runtime.log, "utf8");
  assert.equal((calls.match(/colima\|start/g) ?? []).length, 1);
  assert.equal((calls.match(/compose\|.*\|.* up --build --detach --wait/g) ?? []).length, 2);
  assert.equal(
    calls.includes(
      `colima|start --profile ${profileName} --runtime docker --activate=false --memory 4 --mount ${realpathSync(root)}:w`,
    ),
    true,
  );
  assert.match(
    calls,
    new RegExp(
      `compose\\|host=unix://${join(root, "colima-home", profileName, "docker.sock").replaceAll("/", "\\/")}\\|--project-name ${projectName}`,
    ),
  );

  runContainer(root, "down", env);
  calls = readFileSync(runtime.log, "utf8");
  assert.match(calls, /compose\|.* down --remove-orphans/);
  assert.equal((calls.match(/colima\|stop/g) ?? []).length, 1);
  assert.equal(existsSync(markerPath), false);
  assert.equal(existsSync(join(root, ".local/state/container-profile.json")), true);

  const callsAfterFirstDown = calls;
  runContainer(root, "down", env);
  assert.equal(readFileSync(runtime.log, "utf8"), callsAfterFirstDown);
});

test("container down preserves a named Colima profile that was already running", () => {
  const root = mkdtempSync(join(tmpdir(), "regression-surgeon-container-shared-"));
  createProject(root);
  const runtime = createFakeRuntime(root);
  mkdirSync(join(root, "colima-home", profileName), { recursive: true });
  writeFileSync(runtime.state, "running\n");
  const env = runtimeEnvironment(root, runtime);

  runContainer(root, "up", env);
  const marker = JSON.parse(readFileSync(join(root, ".local/run/container.json"), "utf8"));
  assert.equal(marker.startedProfile, false);
  runContainer(root, "down", env);

  const calls = readFileSync(runtime.log, "utf8");
  assert.equal((calls.match(/colima\|start/g) ?? []).length, 0);
  assert.equal((calls.match(/colima\|stop/g) ?? []).length, 0);
  assert.equal(existsSync(runtime.state), true);
});

test("container down fails closed for an unrecognized ownership marker", () => {
  const root = mkdtempSync(join(tmpdir(), "regression-surgeon-container-marker-"));
  createProject(root);
  const runtime = createFakeRuntime(root);
  const markerDirectory = join(root, ".local/run");
  mkdirSync(markerDirectory, { recursive: true });
  writeFileSync(
    join(markerDirectory, "container.json"),
    JSON.stringify({
      createdProfile: true,
      profile: "default",
      project: projectName,
      startedProfile: true,
    }),
  );

  assert.throws(() => runContainer(root, "down", runtimeEnvironment(root, runtime)));
  assert.equal(existsSync(runtime.log), false);
  assert.equal(existsSync(join(markerDirectory, "container.json")), true);
});

test("teardown delegates owned container cleanup before removing runtime state", () => {
  const root = mkdtempSync(join(tmpdir(), "regression-surgeon-container-teardown-"));
  createProject(root);
  const scripts = join(root, "scripts");
  mkdirSync(scripts);
  copyFileSync(join(repoRoot, "scripts/container.mjs"), join(scripts, "container.mjs"));
  copyFileSync(join(repoRoot, "scripts/teardown"), join(scripts, "teardown"));
  chmodSync(join(scripts, "teardown"), 0o755);
  const runtime = createFakeRuntime(root);
  const env = runtimeEnvironment(root, runtime);
  runContainer(root, "up", env);

  execFileSync("sh", [join(scripts, "teardown")], { cwd: root, env, stdio: "pipe" });

  const calls = readFileSync(runtime.log, "utf8");
  assert.match(calls, /compose\|.* down --remove-orphans --volumes/);
  assert.match(calls, new RegExp(`colima\\|stop --profile ${profileName}`));
  assert.match(calls, new RegExp(`colima\\|delete --profile ${profileName} --force`));
  assert.equal(existsSync(join(root, ".local/run")), false);
  assert.equal(existsSync(join(root, ".local/state/container-profile.json")), false);
});

test("a failed Compose start keeps enough ownership evidence for safe recovery", () => {
  const root = mkdtempSync(join(tmpdir(), "regression-surgeon-container-recovery-"));
  createProject(root);
  const runtime = createFakeRuntime(root);
  const env = {
    ...runtimeEnvironment(root, runtime),
    REGRESSION_SURGEON_TEST_COMPOSE_FAIL: "1",
  };

  assert.throws(() => runContainer(root, "up", env));
  assert.equal(existsSync(join(root, ".local/run/container.json")), true);
  assert.equal(existsSync(join(root, ".local/state/container-profile.json")), true);

  runContainer(root, "teardown", runtimeEnvironment(root, runtime));
  const calls = readFileSync(runtime.log, "utf8");
  assert.match(calls, /compose\|.* down --remove-orphans --volumes/);
  assert.match(calls, new RegExp(`colima\\|delete --profile ${profileName} --force`));
  assert.equal(existsSync(join(root, ".local/run/container.json")), false);
  assert.equal(existsSync(join(root, ".local/state/container-profile.json")), false);
});
