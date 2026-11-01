// Controlled movement fixture. Tests recording/export mechanics, not autonomous behavior.
import "../packages/db/src/env";
import assert from "node:assert/strict";
import {mkdir} from "node:fs/promises";
import {createDatabase} from "../packages/db/src";
import {WorldStore,MediaStore,createArchiveStore,PlaybackStore} from "../packages/storage/src";
import {ExportRunner} from "../packages/media/src";
import {createMediaQueue,createMediaWorker} from "../packages/jobs/src";
import {Playback} from "../packages/playback/src";
import {contentHash,parseScenario,type Command} from "../packages/contracts/src";
import {modelRounds,backgroundTasks,memoryCalls} from "../packages/db/src/schema";
import {eq,sql} from "../packages/db/node_modules/drizzle-orm";
import scenario from "../experiments/scenarios/dev/town.json";
const {db,pool}=createDatabase(process.env.DATABASE_URL!),worlds=new WorldStore(db),media=new MediaStore(db),owner=crypto.randomUUID(),archive=createArchiveStore()!;
let runId="";const execute=async(command:Command)=>worlds.execute(runId,owner,await worlds.claim(runId,owner),command);
const queue=createMediaQueue(process.env.REDIS_URL!),runner=new ExportRunner(db),worker=createMediaWorker(process.env.REDIS_URL!,id=>runner.run(id));
async function inference(){const [actor]=await db.select({n:sql<number>`count(*)::int`}).from(modelRounds).innerJoin(backgroundTasks,eq(backgroundTasks.id,modelRounds.taskId)).where(eq(backgroundTasks.runId,runId));const [memory]=await db.select({n:sql<number>`count(*)::int`}).from(memoryCalls).where(eq(memoryCalls.runId,runId));return{actor:actor!.n,memory:memory!.n}}
try{await worker.waitUntilReady();const input=parseScenario(scenario),citizen=input.citizens[0]!;runId=(await worlds.create(input,"phase5-video-mechanics-fixture")).state.runId;
 await execute({id:"say",action:{kind:"say",actorId:citizen.id,text:"Recording a walk through town."}});await execute({id:"walk",action:{kind:"move",actorId:citizen.id,destination:{x:citizen.position.x+3,y:citizen.position.y}}});await execute({id:"advance",action:{kind:"advance",durationMs:2000}});await execute({id:"checkpoint",action:{kind:"set-status",status:"paused"}});
 const before=await worlds.current(runId),calls=await inference(),request={startMs:input.startTimeMs,endMs:input.startTimeMs+2000,speed:1,fps:30 as const,width:1280 as const,height:720 as const,camera:{x:384,y:256,zoom:1.25}};
 const id=await media.create(runId,request);await queue.add("media.export",{taskId:id},{jobId:id,attempts:1});console.log(`Video fixture ${runId}, ${id}`);
 const until=Date.now()+180000;let row;
 while(Date.now()<until){row=(await media.list(runId)).find(item=>item.export.id===id);if(row?.status==="completed"||row?.status==="failed")break;await Bun.sleep(500)}
 assert.equal(row?.status,"completed",row?.error??"Export timeout");assert.equal((await worlds.current(runId)).stateHash,before.stateHash);assert.deepEqual(await inference(),calls);assert.deepEqual(calls,{actor:0,memory:0});
 await mkdir(".local",{recursive:true});for(const file of row!.export.files!){const bytes=await archive.read(file.key,file.checksum,file.bytes);await Bun.write(`.local/phase5-${file.kind}.${file.kind==="video"?"mp4":file.kind==="thumbnail"?"png":"json"}`,bytes)}
 const probe=Bun.spawn(["ffprobe","-v","error","-select_streams","v:0","-show_entries","stream=width,height,r_frame_rate,nb_frames:format=duration","-of","json",".local/phase5-video.mp4"],{stdout:"pipe",stderr:"pipe"});const data=JSON.parse(await new Response(probe.stdout).text());assert.equal(await probe.exited,0);assert.equal(data.streams[0].width,1280);assert.equal(data.streams[0].height,720);assert.equal(data.streams[0].r_frame_rate,"30/1");assert.equal(Number(data.streams[0].nb_frames),60);
 const playback=new Playback(await new PlaybackStore(db).bundle(runId,request.startMs,request.endMs,before.state.sequence)),metadata=row!.export.metadata!;
 for(const sample of metadata.samples as {timeMs:number;sequence:number;stateHash:string}[]){assert.equal(sample.sequence,playback.stateAt(sample.timeMs).sequence);assert.equal(sample.stateHash,await contentHash(playback.stateAt(sample.timeMs)))}
 const report={status:"passed",kind:"controlled-fixture; no autonomous behavior claim",runId,exportId:id,sourceHash:before.stateHash,inferenceBefore:calls,inferenceAfter:await inference(),probe:data,metadata};await Bun.write(".local/phase-5-video-proof.json",JSON.stringify(report,null,2));console.log(JSON.stringify({status:"passed",runId,exportId:id,frames:60,inferenceCalls:0,videoBytes:row!.export.files!.find(file=>file.kind==="video")!.bytes}));
}finally{await worker.close();await queue.close();if(runId)await worlds.release(runId,owner,await worlds.claim(runId,owner));archive.close();await pool.end()}
