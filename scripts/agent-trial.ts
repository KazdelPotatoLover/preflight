import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { serve } from '@hono/node-server';
import { createApp } from '../src/app.js';
import { connectDatabase } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { CollaborationService } from '../src/domain/service.js';
import { AgentRuntime } from '../src/adapter/runtime.js';
import type { Actor } from '../src/domain/contracts.js';
import type { Credential } from '../src/config.js';
import type * as t from '../src/db/schema.js';
const run = promisify(execFile), url=process.env.DATABASE_URL; if (!url) throw new Error('DATABASE_URL required');
const trials=Number(process.env.PREFLIGHT_TRIALS ?? 3); if (!Number.isInteger(trials) || trials<1 || trials>3) throw new Error('Trials must be 1..3');
const report: unknown[]=[];
for(let trial=1;trial<=trials;trial++) {
  const schema=`agents_${randomUUID().replaceAll('-','')}`,repo=`trial/${randomUUID()}`,root=resolve(`.preflight/agent-trials/${Date.now()}-${trial}`);
  const admin=postgres(url,{max:1,onnotice:()=>{}});await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  const connection=connectDatabase(url,schema);await migrate(url,schema);
  const service=new CollaborationService(connection.db),lead: Actor={member:'trial-lead',role:'human',repo};
  const tokens=[randomBytes(32).toString('hex'),randomBytes(32).toString('hex')];
  const credentials: Credential[]=tokens.map((token,i)=>({member:`agent-${i+1}`,role:'agent',repo,token_hash:createHash('sha256').update(token).digest('hex'),expires_at:new Date(Date.now()+3600000).toISOString()}));
  const server=serve({fetch:createApp({service,credentials:()=>credentials}).fetch,hostname:'127.0.0.1',port:0});if(!server.listening) await new Promise<void>(r=>server.once('listening',r));
  const address=server.address();assert(address&&typeof address!=='string');
  const worker=setInterval(()=>{void service.maintain().catch(()=>{});},1000);
  const adapters: AgentRuntime[]=[];let runs: Promise<unknown>[]=[];
  try {
    const write=async <T>(action: Parameters<CollaborationService['execute']>[1], args: Record<string,unknown>)=>service.execute(lead,action,{request_id:randomUUID(),...args}) as Promise<T>;
    const {project}=await write<{project: typeof t.projects.$inferSelect}>('preflight_manage_project',{operation:'create',title:`Real agent trial ${trial}`,description:'Autonomous project coordination acceptance fixture'});
    const {milestone}=await write<{milestone: typeof t.milestones.$inferSelect}>('preflight_manage_milestone',{operation:'create',project_id:project.id,title:'Normalization delivery'});
    const {goal: upstream}=await write<{goal:typeof t.goals.$inferSelect}>('preflight_register_goal',{project_id:project.id,milestone_id:milestone.id,title:'Specify normalization',objective:'Define trim then uppercase normalization and share reusable contract and cases. Work independently within these boundaries.',plan_state:'ready',priority:1,acceptance:['Publish a contract finding naming trim then uppercase and fixture marker; commit contract.json with example and verify it.','Characterize empty, whitespace and mixed-case input; commit cases.json and verify it, publish findings.']});
    const {goal: downstream}=await write<{goal:typeof t.goals.$inferSelect}>('preflight_register_goal',{project_id:project.id,milestone_id:milestone.id,title:'Implement normalization',objective:'After upstream contract is complete, read its shared finding, implement normalize.mjs exporting normalize(input) and normalize.test.mjs using node:test. Publish a finding citing the upstream finding UUID and fixture marker and actual test results. Commit files and provide SHA-specific evidence.',plan_state:'ready',priority:3,acceptance:['normalize(input) trims then uppercases strings, handles empty strings; node --test normalize.test.mjs passes. A downstream finding explicitly cites upstream contract finding ID and fixture marker.']});
    const propose=async(goalId:string,title:string,index:number,deps:string[]=[])=>write<{change:t.Change}>('preflight_start_work',{goal_id:goalId,title,agent_type:'fixture-planning',mode:'propose',task_acceptance:[title+' implemented, committed and verified with an actual command'],goal_criteria_indices:[index],depends_on_change_ids:deps});
    const {change: contract}=await propose(upstream.id,'Define contract.json and publish contract with fixture marker',0);
    await propose(upstream.id,'Characterize inputs in cases.json and publish tested cases',1);
    const {change: implementation}=await propose(downstream.id,'Implement normalize.mjs with node tests; cite upstream contract finding',0,[contract.id]);
    const marker=randomUUID(),dirs=[resolve(root,'agent-1'),resolve(root,'agent-2')];
    for(const cwd of dirs) {
      await mkdir(cwd,{recursive:true});await writeFile(resolve(cwd,'AGENTS.md'),'This is an isolated real model acceptance fixture. Do not create subagents or read outside this directory. Use Preflight tools for peer context. Commit local deliverables with an English Conventional Commit title. Do not push.\n');
      await writeFile(resolve(cwd,'fixture.json'),JSON.stringify({marker,inputs:[' hello ','','   ','MiXeD']}));
      await run('git',['init','-q','--initial-branch=main'],{cwd});await run('git',['config','user.name','Preflight Trial'],{cwd});await run('git',['config','user.email','trial@localhost'],{cwd});await run('git',['add','.'],{cwd});await run('git',['commit','-qm','chore: initialize isolated acceptance fixture'],{cwd});
    }
    for(let i=0;i<2;i++) adapters.push(new AgentRuntime({url:`http://127.0.0.1:${address.port}/mcp`,token:tokens[i]!,projectId:project.id,cwd:dirs[i]!,journal:resolve(root,`runtime-${i+1}.json`),maxTurns:8,maxMinutes:8,pollMs:2000}));
    let failure: unknown;
    runs=adapters.map(a=>a.run().catch(e=>{failure=e;return {error:e instanceof Error?e.message:'runtime failed'};}));
    const deadline=Date.now()+480000;
    let board=await service.project(lead,project.id);
    while(board.goals.some(g=>g.progress!=='reported_completed') && Date.now()<deadline && !failure) {
      await new Promise(r=>setTimeout(r,2000));board=await service.project(lead,project.id);
    }
    for(const a of adapters)a.stop(); const results=await Promise.all(runs);
    board=await service.project(lead,project.id);
    const findings=(await service.readFindings(lead,{scope:'repo'})).findings;
    const source=findings.filter(f=>f.change_id===contract.id && f.content.includes(marker));
    const reused=findings.filter(f=>f.change_id===implementation.id && source.some(s=>JSON.stringify(f).includes(s.id)) && JSON.stringify(f).includes(marker));
    const completed=board.goals.every(g=>g.progress==='reported_completed');
    assert(!failure,`Runtime failed: ${String(failure)}`);assert(completed,`Trial ${trial} incomplete: ${board.changes.map(c=>c.title+':'+c.status).join(', ')}`);
    assert(source.length,'Upstream must publish actual contract with marker');assert(reused.length,'Downstream must cite actual peer finding and marker');
    const owners=new Set(board.changes.map(c=>c.verification && c.created_by));
    const claimMembers=new Set((await connection.client`SELECT member FROM work_claims`).map(c=>c.member));assert.equal(claimMembers.size,2,'Both independent agents must autonomously take work');
    let artifactChecked=false;
    for(const cwd of dirs) {
      try {await readFile(resolve(cwd,'normalize.mjs'));}catch {continue;}
      await run('node',['--test','normalize.test.mjs'],{cwd});
      const {stdout}=await run('node',['--input-type=module','-e',"import {normalize} from './normalize.mjs'; console.log(JSON.stringify([' hello ','','   ','MiXeD'].map(normalize)))"],{cwd});
      assert.deepEqual(JSON.parse(stdout.trim()),['HELLO','','','MIXED']);artifactChecked=true;
    }
    assert(artifactChecked);void owners;
    const outcome={trial,date:new Date().toISOString(),real_model:true,roles:'autonomously_selected',goals:2,tasks:3,agents:2,completed:true,peer_finding_reuse:true,artifact_tests:true,runtimes:results,cost:'unavailable'};
    report.push(outcome);await writeFile(resolve(root,'result.json'),JSON.stringify(outcome,null,2));console.log(`✓ Real trial ${trial}: both agents chose work, completed 2 goals / 3 tasks, reused upstream finding and passed actual artifact tests`);
  } catch(error) {
    await mkdir(root,{recursive:true});await writeFile(resolve(root,'failure.json'),JSON.stringify({date:new Date().toISOString(),error:error instanceof Error?error.message:'failed',snapshot:await service.project(lead),findings:await service.readFindings(lead,{scope:'repo'})},null,2));throw error;
  } finally {
    for(const a of adapters)a.stop();await Promise.allSettled(runs);clearInterval(worker);await new Promise<void>(r=>server.close(()=>r()));await connection.client.end({timeout:2});await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);await admin.end({timeout:2});
  }
}
await mkdir('.preflight/agent-trials',{recursive:true});await writeFile('.preflight/agent-trials/report.json',JSON.stringify(report,null,2));
