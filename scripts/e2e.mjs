import { createServer } from "vite";

import { verifyLocalStack } from "./local-stack-contract.ts";

const server = await createServer({
  configFile: new URL("../vite.config.ts", import.meta.url).pathname,
  server: { host: "127.0.0.1", port: 0 },
});

try {
  await server.listen();
  const address = server.httpServer?.address();
  if (address === null || typeof address === "string" || address === undefined) {
    throw new Error("Vite did not expose a local TCP address");
  }
  const result = await verifyLocalStack(`http://127.0.0.1:${address.port}`);
  console.log(
    `Local stack verified: ${result.routes.join(", ")}; auxiliary health ${result.health}.`,
  );
} finally {
  await server.close();
}
