// Infrastructure timing. Scenario time/physics remain in versioned scenario data.
export const runtimePolicy = {
  version: "world-runtime-v5",
  tickIntervalMs: 500,
  discoveryIntervalMs: 5000,
  ownershipLeaseMs: 15000,
  outboxIntervalMs: 2000,
  archiveQueue: "simcity-archive",
  archiveAttempts: 5,
  archiveConcurrency: 2,
  archiveBackoffMs: 1000,
  databaseSchema: "drizzle-0004",
  maxConcurrentTransitionsPerRun: 1,
} as const;
