import { join } from "node:path";
import { workspaceRoot } from "@repo/db/env";
import { contentHash, type RunProvenance } from "@repo/contracts";

export async function runProvenance(): Promise<{
  revision: string;
  provenance: RunProvenance;
}> {
  const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: workspaceRoot,
  });
  const status = Bun.spawnSync(["git", "status", "--porcelain"], {
    cwd: workspaceRoot,
  });
  const protocol = await Bun.file(
    join(workspaceRoot, "experiments/protocols/baseline.json"),
  ).json();
  if (
    typeof protocol.id !== "string" ||
    !Number.isSafeInteger(protocol.version)
  )
    throw new Error("Invalid experiment protocol.");
  const lock = await Bun.file(join(workspaceRoot, "bun.lock")).arrayBuffer();
  return {
    revision:
      revision.exitCode === 0 ? revision.stdout.toString().trim() : "unknown",
    provenance: {
      sourceDirty: status.exitCode === 0 ? status.stdout.byteLength > 0 : null,
      dependencyLockHash: new Bun.CryptoHasher("sha256")
        .update(lock)
        .digest("hex"),
      protocol: {
        id: protocol.id,
        version: protocol.version,
        hash: await contentHash(protocol),
      },
    },
  };
}
