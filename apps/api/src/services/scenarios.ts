import { join } from "node:path";
import { workspaceRoot } from "@repo/db/env";
import { parseScenario } from "@repo/contracts";

export async function loadScenarios() {
  const directory = join(workspaceRoot, "experiments/scenarios/dev");
  const scenarios = [];
  for await (const filename of new Bun.Glob("*.json").scan(directory)) {
    scenarios.push(
      parseScenario(await Bun.file(join(directory, filename)).json()),
    );
  }
  return scenarios.sort((a, b) => a.id.localeCompare(b.id));
}
