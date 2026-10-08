import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { serve } from '@hono/node-server';
import { createApp } from '../src/app.js';
import { connectDatabase } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { CollaborationService } from '../src/domain/service.js';
import { AgentRuntime, processIdentity } from '../src/adapter/runtime.js';
import type * as t from '../src/db/schema.js';
const url=process.env.DATABASE_URL;if(!url)throw new Error('DATABASE_URL required');
const schema=`control_${randomUUID().replaceAll('-','')}`,repo=`control/${randomUUID()}`,root=resolve(`.preflight/real-control/${Date.now()}`);
const admin=postgres(url,{max:1,onnotice:()=>{}});await admin.unsafe(`CREATE SCHEMA "${schema}"`);await migrate(url,schema);
const connection=connectDatabase(url,schema),service=new CollaborationService(connection.db),lead={member:'lead',role:'human' as const,repo};const token=randomBytes(32).toString('hex');
const server=serve({fetch:createApp({service,credentials:()=>[{member:'real-control-agent',role:'agent',repo,token_hash:createHash('sha256').update(token).digest('hex'),expires_at:new Date(Date.now()+3600000).toISOString()}]}).fetch,hostname:'127.0.0.1',port:0});if(!server.listening)await new Promise<void>(r=>server.once('listening',r));const address=server.address();assert(address&&typeof address!=='string');
await mkdir(root,{recursive:true});await writeFile(resolve(root,'AGENTS.md'),'Isolated pause/resume capability trial. Do not use subagents or read outside this directory. Do not install dependencies or push.\n');
let sleeping=false,observedInterrupted=false,resumedCompleted=false;
const observe=(method:string,params:Record<string,unknown>)=>{
  const item=params.item as {type?:string;command?:string}|undefined;
  if(method==='item/started'&&item?.type==='commandExecution'&&/sleep\s+45/.test(item.command??''))sleeping=true;
  if(method==='turn/completed'){const turn=params.turn as {status:string};if(turn.status==='interrupted')observedInterrupted=true;if(turn.status==='completed')resumedCompleted=true;}
};
let adapter:AgentRuntime|undefined,running:Promise<unknown>|undefined;
const wait=async(predicate:()=>Promise<boolean>)=>{const deadline=Date.now()+240000;while(Date.now()<deadline){if(await predicate())return;await new Promise(r=>setTimeout(r,200));}throw new Error('Real client control assertion timed out');};
try{
  const write=async<T>(action:Parameters<CollaborationService['execute']>[1],args:Record<string,unknown>)=>service.execute(lead,action,{request_id:randomUUID(),...args}) as Promise<T>;
  const {project:p}=await write<{project:typeof t.projects.$inferSelect}>('preflight_manage_project',{operation:'create',title:'Actual client pause and recovery'});
  let {goal:g}=await write<{goal:typeof t.goals.$inferSelect}>('preflight_register_goal',{project_id:p.id,title:'Pause capability probe',objective:'This is an execution control trial. Claim the existing task, report implementing, execute sleep 45 exactly once via shell. After it completes publish an observation. No other deliverables are needed.',acceptance:['Actual sleep command completes before reporting task completed.'],plan_state:'ready'});
  await write('preflight_start_work',{goal_id:g.id,title:'Run sleep 45 after claiming',agent_type:'control-fixture',mode:'propose',task_acceptance:['Actual sleep 45 completes'],goal_criteria_indices:[0]});
  const config={url:`http://127.0.0.1:${address.port}/mcp`,token,projectId:p.id,cwd:root,journal:resolve(root,'journal.json'),pollMs:500,maxTurns:4,maxMinutes:5,onNotification:observe};
  adapter=new AgentRuntime(config);running=adapter.run();let failure:unknown;void running.catch(e=>{failure=e;});
  await wait(async()=>{if(failure)throw failure;return sleeping&&Boolean((await service.project(lead,p.id)).changes[0]!.claim);});
  ({goal:g}=await write<{goal:typeof g}>('preflight_manage_goal',{goal_id:g.id,expected_version:g.version,plan_state:'paused'}));
  await wait(async()=>{if(failure)throw failure;return observedInterrupted&&(await service.project(lead,p.id)).reliability.stop_controls.some(s=>s.outcome==='stopped'&&s.version===g.version);});
  await wait(async()=>!(await service.project(lead,p.id)).changes[0]!.claim);assert.notEqual((await service.project(lead,p.id)).changes[0]!.status,'completed');adapter.stop();await running;
  const journal=JSON.parse(await readFile(config.journal,'utf8'));resumedCompleted=false;
  adapter=new AgentRuntime(config);running=adapter.run();void running.catch(e=>{failure=e;});
  await wait(async()=>{if(failure)throw failure;return resumedCompleted&&(await service.project(lead,p.id)).reliability.runtimes.some(r=>r.epoch===2&&r.state==='waiting');});adapter.stop();await running;
  const resumed=JSON.parse(await readFile(config.journal,'utf8'));assert.equal(resumed.thread_id,journal.thread_id);assert.equal(resumed.session_id,journal.session_id);
  // Actual abrupt adapter exit while idle. Shorten the isolated heartbeat deadline rather than wait 120 s.
  await promisify(execFile)('git',['init','-q','--initial-branch=main'],{cwd:root});
  const tokenFile=resolve(root,'client-tokens.json');await writeFile(tokenFile,JSON.stringify({clients:[{member:'real-control-agent',role:'agent',token}]}),{mode:0o600});
  const child=spawn(process.execPath,['--env-file=.env','--import','tsx','scripts/agent-runtime.ts'],{env:{...process.env,PREFLIGHT_PROJECT_ID:p.id,PREFLIGHT_MEMBER:'real-control-agent',PREFLIGHT_CLIENT_TOKENS_FILE:tokenFile,PREFLIGHT_MCP_URL:config.url,PREFLIGHT_AGENT_CWD:root,PREFLIGHT_RUNTIME_JOURNAL:config.journal},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});
  try {
    await wait(async()=>{const j=JSON.parse(await readFile(config.journal,'utf8'));return j.turns>resumed.turns&&!j.turn_id&&(await service.project(lead,p.id)).reliability.runtimes.some(r=>r.epoch===3&&r.state==='waiting');});
  } finally {
    const exited=new Promise<void>(r=>child.once('exit',()=>r()));child.kill('SIGKILL');await exited;
  }
  const crashed=JSON.parse(await readFile(config.journal,'utf8'));assert.notEqual(await processIdentity(crashed.owner_pid),crashed.owner_start);
  await connection.client`UPDATE session_runtimes SET expires_at=now()-interval '1 second' WHERE session_id=${journal.session_id}`;await service.maintain();
  resumedCompleted=false;adapter=new AgentRuntime(config);running=adapter.run();void running.catch(e=>{failure=e;});
  await wait(async()=>{if(failure)throw failure;return resumedCompleted&&(await service.project(lead,p.id)).reliability.runtimes.some(r=>r.epoch===4&&r.state==='waiting');});adapter.stop();await running;
  const afterCrash=JSON.parse(await readFile(config.journal,'utf8'));assert.equal(afterCrash.thread_id,journal.thread_id);assert.equal(afterCrash.session_id,journal.session_id);
  await writeFile(resolve(root,'result.json'),JSON.stringify({date:new Date().toISOString(),real_model:true,actual_sleep_started:true,interrupted_completion:true,plan_stop_ack:true,unfinished_preserved:true,same_session_thread_resume:true,runtime_epoch:4,hard_adapter_exit_recovery:true,heartbeat_expiry_injected:true,token_usage:afterCrash.token_usage??null,cost:'unavailable'},null,2));
  console.log('✓ Real Codex: active sleep interrupted by project pause, versioned stop acknowledged, unfinished work preserved, new process resumed same thread/session; abrupt idle adapter exit recovered with epoch 4');
}finally{
  adapter?.stop();await running?.catch(()=>{});await new Promise<void>(r=>server.close(()=>r()));await connection.client.end({timeout:2});await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);await admin.end({timeout:2});
}
