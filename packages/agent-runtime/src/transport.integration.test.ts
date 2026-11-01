// Scripted provider, real SQL commit followed by an injected lost connection.
import { test, expect } from "bun:test";
import "@repo/db/env";
import { createDatabase } from "@repo/db";
import { WorldStore, AgentStore } from "@repo/storage";
import {
  agentPolicy,
  parseScenario,
  type Command,
  type AgentGuard,
  type ModelAnswer,
} from "@repo/contracts";
import { AgentRunner } from "./runner";
import scenario from "../../../experiments/scenarios/dev/town.json";
const live = process.env.RUN_INTEGRATION === "1" ? test : test.skip;
live(
  "a lost acknowledgement after a committed actor action reuses the saved tool request without another model call or effect",
  async () => {
    const { db, pool } = createDatabase(process.env.DATABASE_URL!);
    const worlds = new WorldStore(db),
      agents = new AgentStore(db),
      owner = crypto.randomUUID();
    let runId = "",
      calls = 0,
      lost = false;
    const port = {
      async execute(id: string, command: Command, guard?: AgentGuard) {
        const result = await worlds.execute(
          id,
          owner,
          await worlds.claim(id, owner),
          command,
          guard,
        );
        if (command.action.kind === "wait" && !lost) {
          lost = true;
          throw new Error("Query read timeout");
        }
        return result;
      },
    };
    try {
      const input = parseScenario(scenario),
        citizen = input.citizens[0]!;
      runId = (
        await worlds.create(input, "lost-ack-provider-fixture", undefined, {
          provider: "fixture",
          citizenId: citizen.id,
          model: agentPolicy.model,
          maxRequests: 4,
          spendingLimitMicroUsd: 100000,
        })
      ).state.runId;
      await port.execute(runId, {
        id: "start",
        action: { kind: "set-status", status: "running" },
      });
      await port.execute(runId, {
        id: "ready",
        action: { kind: "advance", durationMs: 1000 },
      });
      const taskId = (await agents.status(runId, citizen.id))!.control.taskId!;
      const runner = new AgentRunner(worlds, agents, port, () => ({
        async respond(): Promise<ModelAnswer> {
          calls++;
          const callId = "wait-call",
            args = '{"durationMs":60000}';
          return {
            model: "fixture",
            responseId: "fixture",
            output: [
              {
                type: "function_call",
                name: "time_wait",
                call_id: callId,
                arguments: args,
              },
            ],
            call: { callId, name: "time_wait", arguments: args },
            inputTokens: 100,
            cachedTokens: 0,
            outputTokens: 30,
          };
        },
      }));
      await runner.run(taskId);
      const once = await worlds.current(runId);
      expect(Object.values(once.state.jobs)).toHaveLength(1);
      await runner.run(taskId);
      expect(calls).toBe(1);
      expect((await agents.status(runId, citizen.id, 0))!.turns).toHaveLength(
        0,
      );
      expect((await worlds.current(runId)).stateHash).toBe(once.stateHash);
      expect((await agents.rounds(taskId))[0]!.outcome?.status).toBe(
        "accepted",
      );
      await port.execute(runId, {
        id: "stop",
        action: { kind: "set-status", status: "paused" },
      });
      console.log(`Lost acknowledgement fixture ${runId}`);
    } finally {
      if (runId)
        await worlds.release(runId, owner, await worlds.claim(runId, owner));
      await pool.end();
    }
  },
  60000,
);
live(
  "an answer held in memory survives a transient persistence failure without another provider call",
  async () => {
    const { db, pool } = createDatabase(process.env.DATABASE_URL!),
      worlds = new WorldStore(db),
      owner = crypto.randomUUID();
    let runId = "",
      calls = 0,
      fail = true;
    class InterruptedAnswers extends AgentStore {
      override async saveAnswer(...args: Parameters<AgentStore["saveAnswer"]>) {
        if (fail) {
          fail = false;
          throw new Error("Query read timeout");
        }
        return super.saveAnswer(...args);
      }
    }
    const agents = new InterruptedAnswers(db),
      port = {
        async execute(id: string, command: Command, guard?: AgentGuard) {
          return worlds.execute(
            id,
            owner,
            await worlds.claim(id, owner),
            command,
            guard,
          );
        },
      };
    try {
      const input = parseScenario(scenario),
        citizen = input.citizens[0]!;
      runId = (
        await worlds.create(input, "answer-persistence-fixture", undefined, {
          provider: "fixture",
          citizenId: citizen.id,
          model: agentPolicy.model,
          maxRequests: 4,
          spendingLimitMicroUsd: 100000,
        })
      ).state.runId;
      await port.execute(runId, {
        id: "start",
        action: { kind: "set-status", status: "running" },
      });
      await port.execute(runId, {
        id: "ready",
        action: { kind: "advance", durationMs: 1000 },
      });
      const taskId = (await agents.status(runId, citizen.id))!.control.taskId!,
        runner = new AgentRunner(worlds, agents, port, () => ({
          async respond() {
            calls++;
            const call = {
              name: "time_wait",
              arguments: '{"durationMs":60000}',
              callId: "once",
            };
            return {
              responseId: "one",
              model: "fixture",
              call,
              output: [
                {
                  type: "function_call",
                  name: call.name,
                  arguments: call.arguments,
                  call_id: call.callId,
                },
              ],
              inputTokens: 100,
              cachedTokens: 0,
              outputTokens: 30,
            };
          },
        }));
      await runner.run(taskId);
      expect(calls).toBe(1);
      expect(
        Object.values((await worlds.current(runId)).state.jobs),
      ).toHaveLength(1);
      expect((await agents.rounds(taskId))[0]!.status).toBe("applied");
      expect(
        (await agents.status(runId, citizen.id))!.budget!.reservedMicroUsd,
      ).toBe(0);
      await port.execute(runId, {
        id: "stop",
        action: { kind: "set-status", status: "paused" },
      });
    } finally {
      if (runId)
        await worlds.release(runId, owner, await worlds.claim(runId, owner));
      await pool.end();
    }
  },
  60000,
);
live("a temporary heartbeat transport failure does not abort an inference while its ownership lease is still valid",async()=>{
 const {db,pool}=createDatabase(process.env.DATABASE_URL!),worlds=new WorldStore(db),owner=crypto.randomUUID();let runId="",calls=0,heartbeats=0;
 class BriefDisconnect extends AgentStore {override async heartbeat(guard:AgentGuard){heartbeats++;if(heartbeats===1)throw new Error("Connection terminated unexpectedly");return super.heartbeat(guard)}}
 const agents=new BriefDisconnect(db),port={async execute(id:string,command:Command,guard?:AgentGuard){return worlds.execute(id,owner,await worlds.claim(id,owner),command,guard)}};
 try{const input=parseScenario(scenario),citizen=input.citizens[0]!;runId=(await worlds.create(input,"heartbeat-continuity-fixture",undefined,{provider:"fixture",citizenId:citizen.id,model:agentPolicy.model,maxRequests:4,spendingLimitMicroUsd:100000})).state.runId;await port.execute(runId,{id:"start",action:{kind:"set-status",status:"running"}});await port.execute(runId,{id:"ready",action:{kind:"advance",durationMs:1000}});
 const taskId=(await agents.status(runId,citizen.id))!.control.taskId!,runner=new AgentRunner(worlds,agents,port,()=>({async respond(_request,signal){calls++;await new Promise<void>((resolve,reject)=>{const timer=setTimeout(resolve,6500);signal?.addEventListener("abort",()=>{clearTimeout(timer);reject(new Error("Request was aborted"))},{once:true})});const call={name:"time_wait",arguments:'{"durationMs":60000}',callId:"heartbeat-once"};return {responseId:"one",model:"fixture",call,output:[{type:"function_call",name:call.name,arguments:call.arguments,call_id:call.callId}],inputTokens:100,cachedTokens:0,outputTokens:30}}}));
 await runner.run(taskId);expect(heartbeats).toBeGreaterThanOrEqual(1);expect(calls).toBe(1);expect(Object.values((await worlds.current(runId)).state.jobs)).toHaveLength(1);await port.execute(runId,{id:"stop",action:{kind:"set-status",status:"paused"}});
 }finally{if(runId)await worlds.release(runId,owner,await worlds.claim(runId,owner));await pool.end()}
},60000);
