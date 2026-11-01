import { config } from "dotenv";
import { fileURLToPath } from "node:url";

export const workspaceRoot = fileURLToPath(
  new URL("../../../", import.meta.url),
);

config({
  path: fileURLToPath(new URL("../../../.env", import.meta.url)),
  quiet: true,
});

export function requireDatabaseUrl() {
  const value = process.env.DATABASE_URL;
  if (!value)
    throw new Error(
      "Set DATABASE_URL in simcity/.env before running database commands.",
    );
  return value;
}
