import type FormaDB from "../db.js";
import type { AgentTask, AgentWorker } from "./types.js";

export class TaskQueue {
  private db: FormaDB;
  private workers = new Map<string, AgentWorker>();
  private queues = new Map<string, AgentTask[]>();
  private onExecute: (agentId: string, task: AgentTask) => void;

  constructor(
    db: FormaDB,
    onExecute: (agentId: string, task: AgentTask) => void,
  ) {
    this.db = db;
    this.onExecute = onExecute;
  }

  getWorker(agentId: string): AgentWorker | undefined {
    return this.workers.get(agentId);
  }

  getQueue(agentId: string): AgentTask[] {
    return this.queues.get(agentId) || [];
  }

  hasWorker(agentId: string): boolean {
    return this.workers.has(agentId);
  }

  workerIds(): IterableIterator<string> {
    return this.workers.keys();
  }

  workerEntries(): IterableIterator<[string, AgentWorker]> {
    return this.workers.entries();
  }

  async selectAgentFromGroup(instanceGroup: string): Promise<string | null> {
    const agents = await this.db
      .getDb()
      .all("SELECT id FROM agents WHERE instance_group = ? ORDER BY id", [
        instanceGroup,
      ]);

    if (agents.length === 0) return null;
    if (agents.length === 1) return agents[0].id;

    let bestAgent = agents[0].id;
    let minLoad = Infinity;

    for (const agent of agents) {
      await this.initWorker(agent.id);
      const worker = this.workers.get(agent.id)!;
      const queue = this.queues.get(agent.id) || [];

      const load = queue.length + (worker.isBusy ? 10 : 0);

      if (load < minLoad) {
        minLoad = load;
        bestAgent = agent.id;
      }
    }

    return bestAgent;
  }

  async initWorker(agentId: string) {
    if (this.workers.has(agentId)) return;

    const agent = await this.db
      .getDb()
      .get("SELECT * FROM agents WHERE id = ?", [agentId]);

    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    this.workers.set(agentId, {
      agentId,
      isBusy: false,
      currentTask: null,
      lastActivity: new Date(),
      totalProcessed: 0,
      instanceGroup: agent.instance_group,
    });

    if (!this.queues.has(agentId)) {
      this.queues.set(agentId, []);
    }
  }

  findExistingTask(agentId: string, messageId: string): AgentTask | null {
    const queue = this.queues.get(agentId) || [];
    const queued = queue.find((t) => t.messageId === messageId);
    if (queued) return queued;

    const worker = this.workers.get(agentId);
    if (worker?.currentTask?.messageId === messageId) {
      return worker.currentTask;
    }

    return null;
  }

  enqueue(agentId: string, task: AgentTask) {
    const queue = this.queues.get(agentId) || [];
    const insertIndex = queue.findIndex((t) => t.priority > task.priority);

    if (insertIndex === -1) {
      queue.push(task);
    } else {
      queue.splice(insertIndex, 0, task);
    }

    this.queues.set(agentId, queue);
  }

  getQueuePosition(agentId: string, taskId: string): number {
    const queue = this.queues.get(agentId) || [];
    return queue.findIndex((t) => t.id === taskId) + 1;
  }

  estimateWaitTime(agentId: string, taskId: string): number {
    const queue = this.queues.get(agentId) || [];
    const position = this.getQueuePosition(agentId, taskId);
    const worker = this.workers.get(agentId);

    const currentTaskRemaining = worker?.isBusy ? 30 : 0;
    return currentTaskRemaining + position * 30;
  }

  tryScheduleNext(agentId: string) {
    const worker = this.workers.get(agentId);
    if (!worker || worker.isBusy) return;

    const queue = this.queues.get(agentId) || [];
    if (queue.length === 0) return;

    const nextTask = queue.shift()!;
    this.queues.set(agentId, queue);

    this.onExecute(agentId, nextTask);
  }

  cancelTask(taskId: string): { agentId: string; task: AgentTask } | null {
    for (const [agentId, queue] of this.queues.entries()) {
      const index = queue.findIndex((t) => t.id === taskId);
      if (index !== -1) {
        const task = queue[index];
        queue.splice(index, 1);
        return { agentId, task };
      }
    }
    return null;
  }
}
