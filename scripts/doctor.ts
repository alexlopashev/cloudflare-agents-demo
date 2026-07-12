import { execFileSync } from "node:child_process";
import { access } from "node:fs/promises";

const expected = new Map<string, string>([
  ["node", "v24.18.0"],
  ["pnpm", "10.34.5"],
  ["wrangler", "4.110.0"],
  ["gh", "2.96.0"],
]);

for (const path of ["mise.toml", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
  await access(path);
}

for (const [tool, version] of expected) {
  const args = tool === "node" ? ["--version"] : ["--version"];
  const output = execFileSync(tool, args, { encoding: "utf8" });
  if (!output.includes(version)) {
    throw new Error(`${tool} version mismatch: expected ${version}, received ${output.trim()}`);
  }
}

console.log("Foundation toolchain is healthy.");
