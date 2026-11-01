import {
  activeConversation,
  conversationPolicy,
  type Action,
  type Conversation,
  type Citizen,
} from "@repo/contracts";
import { WorldTransition, requireRule } from "./transition";
import { distance } from "./geometry";
import { finishJob } from "./jobs";
const asleep = (ctx: WorldTransition, citizen: Citizen) =>
  citizen.actionId && ctx.state.jobs[citizen.actionId]?.kind === "sleep";
function canHear(ctx: WorldTransition, a: Citizen, b: Citizen) {
  return (
    !asleep(ctx, a) &&
    !asleep(ctx, b) &&
    distance(a.position, b.position) <=
      Math.min(a.hearingRadius, b.hearingRadius)
  );
}
export function endConversation(
  ctx: WorldTransition,
  conversation: Conversation,
  reason: string,
) {
  if (conversation.status === "ended") return;
  ctx.emit(
    "conversation.ended",
    `Conversation ended: ${reason}.`,
    {
      conversations: {
        [conversation.id]: {
          ...conversation,
          version: conversation.version + 1,
          status: "ended",
          nextSpeakerId: null,
          endedAtMs: ctx.state.simTimeMs,
          endReason: reason,
        },
      },
    },
    {
      actorId: conversation.initiatorId,
      position: ctx.state.citizens[conversation.initiatorId]!.position,
      audienceIds: [...conversation.participantIds],
    },
  );
}
export function reconcileConversations(ctx: WorldTransition) {
  for (const conversation of Object.values(ctx.state.conversations ?? {}).sort(
    (a, b) => a.id.localeCompare(b.id),
  )) {
    if (conversation.status === "ended") continue;
    const [a, b] = conversation.participantIds.map(
      (id) => ctx.state.citizens[id]!,
    );
    if (ctx.state.simTimeMs >= conversation.expiresAtMs)
      endConversation(ctx, conversation, "timeout");
    else if (!canHear(ctx, a!, b!))
      endConversation(ctx, conversation, "participants can no longer converse");
  }
}
export function conversationAction(
  ctx: WorldTransition,
  action: Extract<
    Action,
    {
      kind:
        | "conversation-start"
        | "conversation-reply"
        | "conversation-end"
        | "alert";
    }
  >,
) {
  const actor = ctx.state.citizens[action.actorId]!;
  if (action.kind === "alert") {
    const target = ctx.state.citizens[action.targetId];
    requireRule(
      target &&
        target.id !== actor.id &&
        distance(actor.position, target.position) <= 1,
      "An urgent alert requires an adjacent person.",
    );
    const job = target.actionId ? ctx.state.jobs[target.actionId] : null;
    if (job?.kind === "sleep")
      finishJob(ctx, job, "interrupted", "Woken by a nearby urgent alert");
    ctx.emit(
      "alert.delivered",
      `${actor.name}: ${action.text}`,
      {
        citizens: {
          [actor.id]: {
            ...ctx.state.citizens[actor.id]!,
            lastSpeech: {
              sequence: ctx.state.sequence + 1,
              simTimeMs: ctx.state.simTimeMs,
              text: action.text,
            },
          },
        },
      },
      {
        actorId: actor.id,
        position: actor.position,
        audienceIds: [actor.id, target.id],
      },
    );
    return;
  }
  if (action.kind === "conversation-start") {
    const target = ctx.state.citizens[action.targetId];
    requireRule(
      target && target.id !== actor.id && canHear(ctx, actor, target),
      "Both conversation participants must be nearby and awake.",
    );
    requireRule(
      !activeConversation(ctx.state, actor.id) &&
        !activeConversation(ctx.state, target.id),
      "A participant already has a conversation.",
    );
    requireRule(
      !Object.values(ctx.state.conversations ?? {}).some(
        (item) =>
          item.status === "ended" &&
          item.participantIds.includes(actor.id) &&
          item.participantIds.includes(target.id) &&
          ctx.state.simTimeMs - (item.endedAtMs ?? 0) <
            conversationPolicy.pairCooldownMs,
      ),
      "This pair needs a pause before another conversation.",
    );
    const id = `${ctx.causeId}-conversation`,
      sequence = ctx.state.sequence + 1;
    const conversation: Conversation = {
      id,
      version: 1,
      participantIds: [actor.id, target.id],
      initiatorId: actor.id,
      status: "invited",
      nextSpeakerId: target.id,
      startedAtMs: ctx.state.simTimeMs,
      expiresAtMs: ctx.state.simTimeMs + conversationPolicy.timeoutMs,
      endedAtMs: null,
      endReason: null,
      turns: [
        {
          sequence,
          simTimeMs: ctx.state.simTimeMs,
          speakerId: actor.id,
          text: action.text,
          listenerIds: [target.id],
          status: "delivered",
          commandId: ctx.causeId,
        },
      ],
    };
    ctx.emit(
      "speech.delivered",
      `${actor.name}: ${action.text}`,
      {
        conversations: { [id]: conversation },
        citizens: {
          [actor.id]: {
            ...actor,
            lastSpeech: {
              sequence,
              simTimeMs: ctx.state.simTimeMs,
              text: action.text,
            },
          },
        },
      },
      {
        actorId: actor.id,
        position: actor.position,
        audienceIds: [actor.id, target.id],
      },
    );
    return;
  }
  const conversation = ctx.state.conversations?.[action.conversationId];
  requireRule(
    conversation &&
      conversation.status !== "ended" &&
      conversation.participantIds.includes(actor.id),
    "No active personal conversation.",
  );
  requireRule(
    conversation.version === action.expectedVersion,
    "Conversation version changed.",
  );
  if (action.kind === "conversation-end") {
    endConversation(ctx, conversation, action.reason);
    return;
  }
  const target =
    ctx.state.citizens[
      conversation.participantIds.find((id) => id !== actor.id)!
    ]!;
  requireRule(
    conversation.nextSpeakerId === actor.id && canHear(ctx, actor, target),
    "It is not your turn or the other person cannot hear you.",
  );
  requireRule(
    ctx.state.simTimeMs < conversation.expiresAtMs,
    "Conversation expired.",
  );
  const sequence = ctx.state.sequence + 1;
  const updated: Conversation = {
    ...conversation,
    version: conversation.version + 1,
    status: "active",
    nextSpeakerId: target.id,
    turns: [
      ...conversation.turns,
      {
        sequence,
        simTimeMs: ctx.state.simTimeMs,
        speakerId: actor.id,
        text: action.text,
        listenerIds: [target.id],
        status: "delivered",
        commandId: ctx.causeId,
      },
    ],
  };
  ctx.emit(
    "speech.delivered",
    `${actor.name}: ${action.text}`,
    {
      conversations: { [updated.id]: updated },
      citizens: {
        [actor.id]: {
          ...actor,
          lastSpeech: {
            sequence,
            simTimeMs: ctx.state.simTimeMs,
            text: action.text,
          },
        },
      },
    },
    {
      actorId: actor.id,
      position: actor.position,
      audienceIds: [actor.id, target.id],
    },
  );
  if (action.end || updated.turns.length >= conversationPolicy.maxTurns)
    endConversation(
      ctx,
      updated,
      action.end ? "speaker ended the exchange" : "turn limit",
    );
}
