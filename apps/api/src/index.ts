import "@repo/db/env";
import { createApp } from "./app";

const port = Number(process.env.PORT || 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT must be an integer between 1 and 65535.");

const { app, close } = createApp(process.env.DATABASE_URL);
const server = Bun.serve({
  hostname: process.env.HOST || "127.0.0.1",
  port,
  fetch: app.fetch,
});
console.log(`Simcity API listening at ${server.url}`);

async function shutdown() {
  await server.stop();
  await close();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
