import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

type Rpc = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message: string } };
export type ToolSpec = { name: string; description?: string; inputSchema: Record<string, unknown> };
export type Turn = { id: string; status: string; items?: { type: string; text?: string }[]; error?: unknown };
export class CodexClient {
  private process: ChildProcessWithoutNullStreams;
  get pid() { return this.process.pid; }
  private failure?: Error;
  private serial = 0;
  private pending = new Map<number, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private turns = new Map<string, Turn>();
  private waiters = new Map<string, { resolve: (t: Turn) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[]>();
  onTool?: (name: string, args: Record<string, unknown>, callId: string, turnId: string) => Promise<unknown>;
  onNotification?: (method: string, params: Record<string, unknown>) => void;
  constructor(binary = 'codex') {
    this.process = spawn(binary, ['app-server', '--listen', 'stdio://'], { stdio: 'pipe', detached: true });
    this.process.stderr.on('data', () => {}); // Never persist raw client stderr or inference payloads.
    createInterface({ input: this.process.stdout }).on('line', line => {
      try { void this.receive(JSON.parse(line) as Rpc).catch(() => this.fail(new Error('Codex protocol handler failed'))); } catch { this.fail(new Error('Invalid Codex protocol response')); }
    });
    this.process.on('error', e => this.fail(e));
    this.process.on('exit', () => this.fail(new Error('Codex process exited')));
  }
  private fail(error: Error) {
    this.failure = error;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear();
    for (const list of this.waiters.values()) for (const w of list) { clearTimeout(w.timer); w.reject(error); } this.waiters.clear();
  }
  private send(message: Rpc) { this.process.stdin.write(JSON.stringify(message) + '\n'); }
  private async receive(message: Rpc) {
    if (message.method && message.id !== undefined) {
      let result: unknown;
      try {
        if (message.method !== 'item/tool/call' || !this.onTool) throw new Error('Unsupported client request');
        result = await this.onTool(String(message.params?.tool), message.params?.arguments as Record<string, unknown>, String(message.params?.callId), String(message.params?.turnId));
        this.send({ id: message.id, result: { contentItems: [{ type: 'inputText', text: JSON.stringify(result) }], success: true } });
      } catch (error) {
        this.send({ id: message.id, result: { contentItems: [{ type: 'inputText', text: error instanceof Error ? error.message : 'Tool failed' }], success: false } });
      }
    } else if (message.id !== undefined) {
      const p = this.pending.get(Number(message.id)); if (!p) return;
      clearTimeout(p.timer); this.pending.delete(Number(message.id));
      if (message.error) p.reject(new Error(message.error.message)); else p.resolve(message.result ?? {});
    } else if (message.method) {
      const params = message.params ?? {};
      if (message.method === 'turn/completed') {
        const turn = params.turn as Turn; this.turns.set(turn.id, turn);
        const list = this.waiters.get(turn.id); if (list) { this.waiters.delete(turn.id); for (const w of list) { clearTimeout(w.timer); w.resolve(turn); } }
        if (this.turns.size > 100) this.turns.delete(this.turns.keys().next().value!);
      }
      this.onNotification?.(message.method, params);
    }
  }
  request(method: string, params: Record<string, unknown> = {}, timeout = 30000) {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = ++this.serial;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer }); this.send({ id, method, params });
    });
  }
  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'preflight', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized', params: {} });
  }
  async start(cwd: string, tools: ToolSpec[] = [], instructions = '') {
    const r = await this.request('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'workspace-write', developerInstructions: instructions,
      dynamicTools: tools.map(t => ({ ...t, description: t.description ?? t.name, type: 'function' })) });
    return (r.thread as { id: string }).id;
  }
  async resume(threadId: string, cwd: string) { await this.request('thread/resume', { threadId, cwd, approvalPolicy: 'never', sandbox: 'workspace-write' }); }
  async begin(threadId: string, text: string) {
    const r = await this.request('turn/start', { threadId, input: [{ type: 'text', text }] }); return (r.turn as Turn).id;
  }
  async completed(turnId: string, timeout = 180000) {
    const existing = this.turns.get(turnId); if (existing) return existing;
    return new Promise<Turn>((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.set(turnId, (this.waiters.get(turnId) ?? []).filter(w => w.timer !== timer)); reject(new Error('Codex turn completion timed out')); }, timeout);
      this.waiters.set(turnId, [...(this.waiters.get(turnId) ?? []), { resolve, reject, timer }]);
    });
  }
  async interrupt(threadId: string, turnId: string) {
    const existing = this.turns.get(turnId); if (existing) return existing;
    try { await this.request('turn/interrupt', { threadId, turnId }); } catch (error) {
      const completed = this.turns.get(turnId); if (completed) return completed;
      throw error;
    }
    return this.completed(turnId, 30000);
  }
  async close() {
    if (this.process.exitCode !== null || this.process.signalCode !== null || !this.process.pid) return;
    const exited = new Promise<void>(resolve => this.process.once('exit', () => resolve()));
    this.process.stdin.end();
    const timer = setTimeout(() => this.process.kill('SIGTERM'), 2000);
    const force = setTimeout(() => this.process.kill('SIGKILL'), 5000);
    await exited; clearTimeout(timer); clearTimeout(force);
  }
}
