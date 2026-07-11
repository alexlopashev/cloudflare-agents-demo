import { access } from "node:fs/promises";

await Promise.all(["package.json", "mise.toml", "pnpm-workspace.yaml"].map((path) => access(path)));
console.log("Foundation build contract verified; application packages arrive in issue #3.");
