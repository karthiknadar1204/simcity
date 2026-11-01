import type { WorldState, RunManifest } from "./types";
export const conversationPolicy = {
  version: "conversation-v1",
  maxTurns: 8,
  timeoutMs: 120000,
  pairCooldownMs: 300000,
} as const;
export interface ConversationTurn {
  sequence: number;
  simTimeMs: number;
  speakerId: string;
  text: string;
  listenerIds: string[];
  status: "delivered";
  commandId: string;
}
export interface Conversation {
  id: string;
  version: number;
  participantIds: [string, string];
  initiatorId: string;
  status: "invited" | "active" | "ended";
  nextSpeakerId: string | null;
  startedAtMs: number;
  expiresAtMs: number;
  endedAtMs: number | null;
  endReason: string | null;
  turns: ConversationTurn[];
}
export function activeConversation(state: WorldState, citizenId: string) {
  return (
    Object.values(state.conversations ?? {}).find(
      (conversation) =>
        conversation.status !== "ended" &&
        conversation.participantIds.includes(citizenId),
    ) ?? null
  );
}
export function configuredAgents(
  manifest: Pick<RunManifest, "agent" | "agents">,
) {
  return manifest.agents ?? (manifest.agent ? [manifest.agent] : []);
}
