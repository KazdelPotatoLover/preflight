import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { AgentRuntime } from '../src/adapter/runtime.js';
const projectId = process.env.PREFLIGHT_PROJECT_ID, member = process.env.PREFLIGHT_MEMBER;
if (!projectId || !member) throw new Error('Set PREFLIGHT_PROJECT_ID and PREFLIGHT_MEMBER');
const tokens = JSON.parse(await readFile(process.env.PREFLIGHT_CLIENT_TOKENS_FILE ?? '.preflight/client-tokens.json', 'utf8')) as { clients: { member: string; role: string; token: string }[] };
const credential = tokens.clients.find(c => c.member === member && c.role === 'agent');
if (!credential) throw new Error('No agent credential for this member');
const cwd = resolve(process.env.PREFLIGHT_AGENT_CWD ?? `.preflight/workspaces/${member.replace(/[^a-zA-Z0-9_-]/g,'_')}-${projectId}`);
const git = promisify(execFile);
let root: string | undefined;
try { root = (await git('git',['rev-parse','--show-toplevel'],{cwd})).stdout.trim(); } catch { /* A fresh default worktree is created below. */ }
if (process.env.PREFLIGHT_AGENT_CWD) {
  if (root !== cwd) throw new Error('PREFLIGHT_AGENT_CWD must be the root of an independent Git worktree');
} else if (root !== cwd) {
  await git('git',['worktree','add','-b',`codex/agent-${member.replace(/[^a-zA-Z0-9_-]/g,'_')}-${projectId.slice(0,8)}`,cwd,'HEAD']);
}
const adapter = new AgentRuntime({ url: process.env.PREFLIGHT_MCP_URL ?? 'http://127.0.0.1:3000/mcp', token: credential.token, projectId, cwd, journal: resolve(process.env.PREFLIGHT_RUNTIME_JOURNAL ?? `.preflight/runtimes/${member}-${projectId}.json`), maxTurns: Number(process.env.PREFLIGHT_MAX_TURNS ?? 12), maxMinutes: Number(process.env.PREFLIGHT_MAX_MINUTES ?? 30) });
process.once('SIGINT', () => adapter.stop()); process.once('SIGTERM', () => adapter.stop());
console.log(await adapter.run());
