import { execFileSync, spawnSync, type ExecFileSyncOptions } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const project = "regression-surgeon" as const;
const profile = "polylane-take-home";
const supportedPlatforms = new Set(["darwin", "linux"]);
const supportedArchitectures = new Set(["arm64", "x64"]);

type RuntimeMarker = {
  createdProfile: boolean;
  profile: typeof profile;
  project: typeof project;
  startedProfile: boolean;
};

type OwnershipMarker = {
  profile: typeof profile;
  project: typeof project;
};

function fail(message: string): never {
  throw new Error(message);
}

function requireRepositoryRoot(root: string): void {
  for (const path of ["mise.toml", "compose.yaml"]) {
    if (!existsSync(join(root, path)))
      fail(`Run the container task from the repository root (${path} is missing).`);
  }
}

function run(executable: string, args: string[], options: ExecFileSyncOptions = {}): void {
  try {
    execFileSync(executable, args, { stdio: "inherit", ...options });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      fail(`${executable} is unavailable; run bootstrap to install the pinned optional tools.`);
    }
    throw error;
  }
}

function profileIsRunning(): boolean {
  const result = spawnSync("colima", ["status", "--profile", profile], { stdio: "ignore" });
  if (result.error) {
    if ("code" in result.error && result.error.code === "ENOENT") {
      fail("colima is unavailable; run bootstrap to install the pinned optional tools.");
    }
    throw result.error;
  }
  return result.status === 0;
}

function validateRuntimeMarker(value: unknown): RuntimeMarker {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("Refusing container cleanup because the ownership marker is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.project !== project ||
    candidate.profile !== profile ||
    typeof candidate.createdProfile !== "boolean" ||
    typeof candidate.startedProfile !== "boolean" ||
    Object.keys(candidate).sort().join(",") !== "createdProfile,profile,project,startedProfile"
  ) {
    fail("Refusing container cleanup because the ownership marker is invalid.");
  }
  return {
    createdProfile: candidate.createdProfile,
    profile: candidate.profile,
    project: candidate.project,
    startedProfile: candidate.startedProfile,
  };
}

function validateOwnershipMarker(value: unknown): OwnershipMarker {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("Refusing container cleanup because the profile ownership marker is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.project !== project ||
    candidate.profile !== profile ||
    Object.keys(candidate).sort().join(",") !== "profile,project"
  ) {
    fail("Refusing container cleanup because the profile ownership marker is invalid.");
  }
  return { profile: candidate.profile, project: candidate.project };
}

function readMarker<T>(markerPath: string, validate: (value: unknown) => T): T {
  try {
    return validate(JSON.parse(readFileSync(markerPath, "utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) {
      fail("Refusing container cleanup because the ownership marker is invalid JSON.");
    }
    throw error;
  }
}

function writeRuntimeMarker(
  markerPath: string,
  createdProfile: boolean,
  startedProfile: boolean,
): void {
  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(
    markerPath,
    `${JSON.stringify({ createdProfile, profile, project, startedProfile }, null, 2)}\n`,
    { flag: "w", mode: 0o600 },
  );
}

function writeOwnershipMarker(markerPath: string): void {
  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, `${JSON.stringify({ profile, project }, null, 2)}\n`, {
    flag: "w",
    mode: 0o600,
  });
}

function compose(root: string, colimaHome: string, args: string[]): void {
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

function start(
  root: string,
  runtimeMarkerPath: string,
  ownershipMarkerPath: string,
  colimaHome: string,
): void {
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

function stop(
  root: string,
  runtimeMarkerPath: string,
  colimaHome: string,
  removeVolumes = false,
): void {
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

function teardown(
  root: string,
  runtimeMarkerPath: string,
  ownershipMarkerPath: string,
  colimaHome: string,
): void {
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
  fail("Usage: node scripts/container.ts <up|down|teardown>");
}

const root = process.cwd();
requireRepositoryRoot(root);
const runtimeMarkerPath = join(root, ".local", "run", "container.json");
const ownershipMarkerPath = join(root, ".local", "state", "container-profile.json");
const colimaHome = resolve(process.env.COLIMA_HOME ?? join(homedir(), ".colima"));

if (operation === "up") start(root, runtimeMarkerPath, ownershipMarkerPath, colimaHome);
else if (operation === "down") stop(root, runtimeMarkerPath, colimaHome);
else teardown(root, runtimeMarkerPath, ownershipMarkerPath, colimaHome);
