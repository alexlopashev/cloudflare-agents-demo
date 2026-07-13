import { execFileSync } from "node:child_process";

const run = (command: string, args: string[]) => execFileSync(command, args, { stdio: "inherit" });

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
