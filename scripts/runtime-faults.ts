import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { serve } from '@hono/node-server';
import { createApp } from '../src/app.js';
import { connectDatabase } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { CollaborationService } from '../src/domain/service.js';
import { AgentRuntime } from '../src/adapter/runtime.js';
import type * as t from '../src/db/schema.js';
const url=process.env.DATABASE_URL;if(!url)throw new Error('DATABASE_URL required');
const schema=`faults_${randomUUID().replaceAll('-','')}`,repo=`faults/${randomUUID()}`,root=resolve(`.preflight/runtime-faults/${randomUUID()}`);
const admin=postgres(url,{max:1,onnotice:()=>{}});await admin.unsafe(`CREATE SCHEMA "${schema}"`);await migrate(url,schema);
const connection=connectDatabase(url,schema),service=new CollaborationService(connection.db),lead={member:'lead',role:'human' as const,repo};
const token=randomBytes(32).toString('hex');
const server=serve({fetch:createApp({service,credentials:()=>[{member:'fault-client',role:'agent',repo,token_hash:createHash('sha256').update(token).digest('hex'),expires_at:new Date(Date.now()+3600000).toISOString()}]}).fetch,hostname:'127.0.0.1',port:0});if(!server.listening)await new Promise<void>(r=>server.once('listening',r));const address=server.address();assert(address&&typeof address!=='string');
const fake=resolve(root,'fault-client.mjs');await mkdir(root,{recursive:true});
// Deterministic transport peer for fault injection only. This is not model acceptance.
await writeFile(fake,`#!/usr/bin/env node
import {createInterface} from 'node:readline';
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');let serial=0,active,thread='fault-thread';
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='thread/start'||m.method==='thread/resume')send({id:m.id,result:{thread:{id:thread}}});
 if(m.method==='turn/start'){
  const id='turn-'+(++serial);active=id;send({id:m.id,result:{turn:{id,status:'inProgress'}}});
  const text=m.params.input[0].text,board=JSON.parse(text.split('Snapshot:\\n')[1].split('\\nPending updates')[0]);
  const work=board.available_work[0];
  if(work)send({id:'tool-'+serial,method:'item/tool/call',params:{threadId:thread,turnId:id,callId:'claim-'+serial,tool:'preflight_manage_claim',arguments:{request_id:'00000000-0000-4000-8000-000000000001',operation:'claim',change_id:work.id,expected_version:work.version}}});
  else {send({method:'turn/completed',params:{threadId:thread,turn:{id,status:'completed',items:[]}}});active=undefined;}
 }
 if(m.method==='turn/interrupt'){send({id:m.id,result:{}});if(active){send({method:'turn/completed',params:{threadId:thread,turn:{id:active,status:'interrupted',items:[]}}});active=undefined;}}
});process.stdin.on('end',()=>process.exit());
`,{mode:0o700});await chmod(fake,0o700);
let adapter: AgentRuntime|undefined, running: Promise<unknown>|undefined;
const wait=async(predicate:()=>Promise<boolean>)=>{const deadline=Date.now()+15000;while(Date.now()<deadline){if(await predicate())return;await new Promise(r=>setTimeout(r,100));}throw new Error('Fault assertion timed out');};
try {
  const write=async<T>(action:Parameters<CollaborationService['execute']>[1],args:Record<string,unknown>)=>service.execute(lead,action,{request_id:randomUUID(),...args}) as Promise<T>;
  const {project:p}=await write<{project:typeof t.projects.$inferSelect}>('preflight_manage_project',{operation:'create',title:'Fault fixture'});
  let {goal:g}=await write<{goal:typeof t.goals.$inferSelect}>('preflight_register_goal',{project_id:p.id,title:'Long task',objective:'Transport fault fixture',acceptance:['Remain unfinished'],plan_state:'ready'});
  await write('preflight_start_work',{goal_id:g.id,title:'Long task',agent_type:'fixture',mode:'propose',task_acceptance:['Remain unfinished'],goal_criteria_indices:[0]});
  const config={url:`http://127.0.0.1:${address.port}/mcp`,token,projectId:p.id,cwd:root,journal:resolve(root,'journal.json'),binary:fake,pollMs:100,heartbeatMs:300,maxTurns:5,maxMinutes:1};
  adapter=new AgentRuntime(config);running=adapter.run();
  await wait(async()=>Boolean((await service.project(lead,p.id)).changes[0]?.claim));
  let board=await service.project(lead,p.id);const sessionId=board.changes[0]!.claim!.session_id,leaseId=board.changes[0]!.claim!.id;
  await connection.client`UPDATE work_claims SET expires_at=now()+interval '2 seconds' WHERE id=${leaseId}`;
  await wait(async()=>Date.parse((await service.project(lead,p.id)).changes[0]!.claim?.expires_at??'0')>Date.now()+300000);
  console.log('✓ Simulated long inference does not block real SDK heartbeat and lease renewal');
  await assert.rejects(new AgentRuntime(config).run(),/Another process owns/);
  ({goal:g}=await write<{goal:typeof g}>('preflight_manage_goal',{goal_id:g.id,expected_version:g.version,plan_state:'paused'}));
  await wait(async()=>(await service.project(lead,p.id)).reliability.stop_controls.some(s=>s.version===g.version&&s.outcome==='stopped'));
  await wait(async()=>!(await service.project(lead,p.id)).changes[0]!.claim);
  board=await service.project(lead,p.id);assert.equal(board.changes[0]!.status,'probable');
  assert.equal(board.reliability.runtimes.find(r=>r.session_id===sessionId)!.state,'waiting');
  adapter.stop();await running;
  const previous=JSON.parse(await readFile(config.journal,'utf8'));assert(previous.thread_id);assert.equal(previous.owner_pid,0);
  adapter=new AgentRuntime(config);running=adapter.run();
  await wait(async()=>(await service.project(lead,p.id)).reliability.runtimes.some(r=>r.session_id===sessionId&&r.epoch===2));
  adapter.stop();await running;
  const recovered=JSON.parse(await readFile(config.journal,'utf8'));assert.equal(recovered.thread_id,previous.thread_id);
  console.log('✓ Plan pause interrupts the controlled transport turn, records separate stop feedback, releases responsibility and preserves unfinished work');
  console.log('✓ Duplicate local owner rejected; restart resumes same thread/session with new server epoch and kernel lock recovery');
  ({goal:g}=await write<{goal:typeof g}>('preflight_manage_goal',{goal_id:g.id,expected_version:g.version,plan_state:'ready'}));
  const lossConfig={...config,journal:resolve(root,'loss-journal.json')};
  adapter=new AgentRuntime(lossConfig);running=adapter.run();void running.catch(()=>{});
  await wait(async()=>{try{return Boolean(JSON.parse(await readFile(lossConfig.journal,'utf8')).lease);}catch{return false;}});
  const loss=JSON.parse(await readFile(lossConfig.journal,'utf8'));
  await connection.client`UPDATE work_claims SET expires_at=now()-interval '1 second' WHERE id=${loss.lease.id}`;await service.maintain();
  await assert.rejects(running,/Responsibility lease lost/);
  assert.equal((await service.project(lead,p.id)).reliability.runtimes.find(r=>r.session_id===loss.session_id)!.state,'error');
  console.log('✓ Responsibility loss interrupts inference and closes runtime as error instead of silently continuing');

}finally{
  adapter?.stop();await running?.catch(()=>{});await new Promise<void>(r=>server.close(()=>r()));await connection.client.end({timeout:2});await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);await admin.end({timeout:2});
}
