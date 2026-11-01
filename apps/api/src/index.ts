import "@repo/db/env";
import { createApp } from "./app";

const port = Number(process.env.PORT || 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT must be an integer between 1 and 65535.");

const { app, start, close } = createApp(process.env.DATABASE_URL);
if (
  !["127.0.0.1", "localhost", "::1"].includes(
    process.env.HOST || "127.0.0.1",
  ) &&
  !process.env.OPERATOR_TOKEN
)
  throw new Error(
    "Set OPERATOR_TOKEN before binding the operator API outside loopback.",
  );
await start();
const server = Bun.serve({
  hostname: process.env.HOST || "127.0.0.1",
  port,
  idleTimeout: 30,
  fetch: app.fetch,
});
console.log(`Simcity API listening at ${server.url}`);

async function shutdown() {
  await server.stop(true);
  await close();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
