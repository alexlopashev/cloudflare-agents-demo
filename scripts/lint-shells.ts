import { execFileSync } from "node:child_process";

const run = (command: string, args: string[]) => execFileSync(command, args, { stdio: "inherit" });

const isMissingCommand = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

run("shellcheck", [
  "scripts/bootstrap",
  "scripts/activate",
  "scripts/bootstrap-core.sh",
  "scripts/teardown",
]);
run("shfmt", [
  "-d",
  "-i",
  "2",
  "-ci",
  "scripts/bootstrap",
  "scripts/activate",
  "scripts/bootstrap-core.sh",
  "scripts/teardown",
]);
run("actionlint", [".github/workflows/ci.yml"]);

try {
  run("fish", [
    "--no-execute",
    "scripts/bootstrap.fish",
    "scripts/activate.fish",
    "scripts/teardown.fish",
  ]);
} catch (error) {
  if (!isMissingCommand(error)) throw error;
  console.log("Fish syntax gate deferred to CI because Fish is not installed on this host.");
}

try {
  run("nu", [
    "--no-config-file",
    "--commands",
    '$env.REGRESSION_SURGEON_BOOTSTRAP_TEST = "1"; source scripts/bootstrap.nu',
  ]);
} catch (error) {
  if (!isMissingCommand(error)) throw error;
  console.log("Nu syntax gate deferred to CI because Nu is not installed on this host.");
}
