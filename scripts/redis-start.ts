import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import "../packages/db/src/env";

const root = fileURLToPath(new URL("../", import.meta.url));
const url = new URL(process.env.REDIS_URL || "redis://127.0.0.1:6387");
if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.password)
  throw new Error(
    "redis:start only starts an unauthenticated loopback development service. Use your managed service for a remote REDIS_URL.",
  );
const port = url.port || "6387";
const directory = `${root}.local/redis`;
await mkdir(directory, { recursive: true });
const ping = Bun.spawnSync([
  "redis-cli",
  "-h",
  url.hostname,
  "-p",
  port,
  "ping",
]);
if (ping.exitCode === 0) {
  console.log(
    "Redis is already running. Check its persistence configuration before sharing it with another application.",
  );
} else {
  const result = Bun.spawnSync(
    [
      "redis-server",
      "--bind",
      "127.0.0.1",
      "--port",
      port,
      "--dir",
      directory,
      "--appendonly",
      "yes",
      "--appendfsync",
      "everysec",
      "--maxmemory-policy",
      "noeviction",
      "--daemonize",
      "yes",
      "--pidfile",
      `${directory}/redis.pid`,
      "--logfile",
      `${directory}/redis.log`,
    ],
    { cwd: root },
  );
  if (result.exitCode !== 0)
    throw new Error(
      "Redis failed to start. Install redis-server or configure REDIS_URL.",
    );
  console.log(
    `Development Redis started on port ${port} with AOF persistence and noeviction.`,
  );
}
