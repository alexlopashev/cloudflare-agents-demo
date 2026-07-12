import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const project = "regression-surgeon";
const profile = "polylane-take-home";
const supportedPlatforms = new Set(["darwin", "linux"]);
const supportedArchitectures = new Set(["arm64", "x64"]);

/** @typedef {{ createdProfile: boolean, profile: string, project: string, startedProfile: boolean }} RuntimeMarker */
/** @typedef {{ profile: string, project: string }} OwnershipMarker */

/** @param {string} message @returns {never} */
function fail(message) {
  throw new Error(message);
}

/** @param {string} root */
function requireRepositoryRoot(root) {
  for (const path of ["mise.toml", "compose.yaml"]) {
    if (!existsSync(join(root, path)))
      fail(`Run the container task from the repository root (${path} is missing).`);
  }
}

/**
 * @param {string} executable
 * @param {string[]} args
 * @param {import("node:child_process").ExecFileSyncOptions} [options]
 */
function run(executable, args, options = {}) {
  try {
    execFileSync(executable, args, { stdio: "inherit", ...options });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      fail(`${executable} is unavailable; run bootstrap to install the pinned optional tools.`);
    }
    throw error;
  }
}

function profileIsRunning() {
  const result = spawnSync("colima", ["status", "--profile", profile], { stdio: "ignore" });
  if (result.error) {
    if ("code" in result.error && result.error.code === "ENOENT") {
      fail("colima is unavailable; run bootstrap to install the pinned optional tools.");
    }
    throw result.error;
  }
  return result.status === 0;
}

/** @param {unknown} value @returns {RuntimeMarker} */
function validateRuntimeMarker(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("Refusing container cleanup because the ownership marker is invalid.");
  }
  const candidate = /** @type {Record<string, unknown>} */ (value);
  if (
    candidate.project !== project ||
    candidate.profile !== profile ||
    typeof candidate.createdProfile !== "boolean" ||
    typeof candidate.startedProfile !== "boolean" ||
    Object.keys(candidate).sort().join(",") !== "createdProfile,profile,project,startedProfile"
  ) {
    fail("Refusing container cleanup because the ownership marker is invalid.");
  }
  return /** @type {RuntimeMarker} */ (candidate);
}

/** @param {unknown} value @returns {OwnershipMarker} */
function validateOwnershipMarker(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("Refusing container cleanup because the profile ownership marker is invalid.");
  }
  const candidate = /** @type {Record<string, unknown>} */ (value);
  if (
    candidate.project !== project ||
    candidate.profile !== profile ||
    Object.keys(candidate).sort().join(",") !== "profile,project"
  ) {
    fail("Refusing container cleanup because the profile ownership marker is invalid.");
  }
  return /** @type {OwnershipMarker} */ (candidate);
}

/** @template T @param {string} markerPath @param {(value: unknown) => T} validate @returns {T} */
function readMarker(markerPath, validate) {
  try {
    return validate(JSON.parse(readFileSync(markerPath, "utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) {
      fail("Refusing container cleanup because the ownership marker is invalid JSON.");
    }
    throw error;
  }
}

/** @param {string} markerPath @param {boolean} createdProfile @param {boolean} startedProfile */
function writeRuntimeMarker(markerPath, createdProfile, startedProfile) {
  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(
    markerPath,
    `${JSON.stringify({ createdProfile, profile, project, startedProfile }, null, 2)}\n`,
    { flag: "w", mode: 0o600 },
  );
}

/** @param {string} markerPath */
function writeOwnershipMarker(markerPath) {
  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, `${JSON.stringify({ profile, project }, null, 2)}\n`, {
    flag: "w",
    mode: 0o600,
  });
}

/** @param {string} root @param {string} colimaHome @param {string[]} args */
function compose(root, colimaHome, args) {
  run(
    "docker-cli-plugin-docker-compose",
    ["--project-name", project, "--file", "compose.yaml", ...args],
    {
      cwd: root,
      env: {
        ...process.env,
        DOCKER_HOST: `unix://${join(colimaHome, profile, "docker.sock")}`,
      },
    },
  );
}

/** @param {string} root @param {string} runtimeMarkerPath @param {string} ownershipMarkerPath @param {string} colimaHome */
function start(root, runtimeMarkerPath, ownershipMarkerPath, colimaHome) {
  const existingMarker = existsSync(runtimeMarkerPath)
    ? readMarker(runtimeMarkerPath, validateRuntimeMarker)
    : undefined;
  const hasOwnershipMarker = existsSync(ownershipMarkerPath);
  if (hasOwnershipMarker) readMarker(ownershipMarkerPath, validateOwnershipMarker);
  const profilePath = join(colimaHome, profile);
  const profileExisted = existsSync(profilePath);
  const running = profileIsRunning();
  let startedProfile = existingMarker?.startedProfile ?? false;
  let createdProfile = existingMarker?.createdProfile ?? hasOwnershipMarker;

  if (!running) {
    run("colima", [
      "start",
      "--profile",
      profile,
      "--runtime",
      "docker",
      "--activate=false",
      "--memory",
      "4",
      "--mount",
      `${root}:w`,
    ]);
    startedProfile = true;
    if (!profileExisted) {
      createdProfile = true;
      writeOwnershipMarker(ownershipMarkerPath);
    }
  }

  writeRuntimeMarker(runtimeMarkerPath, createdProfile, startedProfile);
  compose(root, colimaHome, ["up", "--build", "--detach", "--wait"]);
  console.log("Optional container stack is ready at http://127.0.0.1:5173.");
}

/** @param {string} root @param {string} runtimeMarkerPath @param {string} colimaHome @param {boolean} [removeVolumes] */
function stop(root, runtimeMarkerPath, colimaHome, removeVolumes = false) {
  if (!existsSync(runtimeMarkerPath)) {
    console.log("No project-owned container runtime is active.");
    return;
  }

  const marker = readMarker(runtimeMarkerPath, validateRuntimeMarker);
  if (profileIsRunning()) {
    compose(root, colimaHome, [
      "down",
      "--remove-orphans",
      ...(removeVolumes ? ["--volumes"] : []),
    ]);
    if (marker.startedProfile) run("colima", ["stop", "--profile", profile]);
  }
  rmSync(runtimeMarkerPath);
  console.log("Project-owned container runtime stopped.");
}

/** @param {string} root @param {string} runtimeMarkerPath @param {string} ownershipMarkerPath @param {string} colimaHome */
function teardown(root, runtimeMarkerPath, ownershipMarkerPath, colimaHome) {
  if (existsSync(runtimeMarkerPath)) stop(root, runtimeMarkerPath, colimaHome, true);
  if (!existsSync(ownershipMarkerPath)) {
    console.log("No project-owned Colima profile remains.");
    return;
  }

  readMarker(ownershipMarkerPath, validateOwnershipMarker);
  const profilePath = join(colimaHome, profile);
  if (existsSync(profilePath)) {
    if (profileIsRunning()) {
      compose(root, colimaHome, ["down", "--remove-orphans", "--volumes"]);
      run("colima", ["stop", "--profile", profile]);
    }
    run("colima", ["delete", "--profile", profile, "--force", "--data"]);
  }
  rmSync(ownershipMarkerPath);
  console.log("Project-owned Colima profile removed.");
}

if (!supportedPlatforms.has(process.platform) || !supportedArchitectures.has(process.arch)) {
  fail(
    `Unsupported container host: ${process.platform}/${process.arch} (expected macOS or Linux on ARM64 or x64).`,
  );
}

const operation = process.argv[2];
if (operation !== "up" && operation !== "down" && operation !== "teardown") {
  fail("Usage: node scripts/container.mjs <up|down|teardown>");
}

const root = process.cwd();
requireRepositoryRoot(root);
const runtimeMarkerPath = join(root, ".local", "run", "container.json");
const ownershipMarkerPath = join(root, ".local", "state", "container-profile.json");
const colimaHome = resolve(process.env.COLIMA_HOME ?? join(homedir(), ".colima"));

if (operation === "up") start(root, runtimeMarkerPath, ownershipMarkerPath, colimaHome);
else if (operation === "down") stop(root, runtimeMarkerPath, colimaHome);
else teardown(root, runtimeMarkerPath, ownershipMarkerPath, colimaHome);
