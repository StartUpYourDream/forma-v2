import type FormaDB from "../db.js";
import { broadcastToProject } from "../websocket.js";
import type {
  AgentTask,
  AgentExecution,
  ILLMClient,
  ChatMessage,
} from "./types.js";
import { createLLMClient } from "./llm/index.js";
import { ToolExecutor } from "./tool-executor.js";
import { PromptBuilder } from "./prompt-builder.js";

import { TaskQueue } from "./task-queue.js";

// ============ Agent 调度中心 ============
export class AgentScheduler {
  private db: FormaDB;
  private defaultLLMClient: ILLMClient;
  private toolExecutor: ToolExecutor;
  private promptBuilder: PromptBuilder;
  private taskQueue: TaskQueue;
  private executions = new Map<string, AgentExecution>();
  private readonly DEFAULT_TIMEOUT = 5 * 60 * 1000;
  private readonly MAX_RETRIES = 3;
  private readonly MAX_MENTION_DEPTH = 3;
  // [问题7] 已完成执行记录的最大保留数量
  private readonly MAX_EXECUTIONS_CACHE = 500;

  constructor(db: FormaDB) {
    this.db = db;
    this.defaultLLMClient = createLLMClient("openai", {
      apiKey: process.env.OPENAI_API_KEY || "sk-test",
      baseURL: process.env.OPENAI_BASE_URL,
    });
    this.toolExecutor = new ToolExecutor(db);
    this.promptBuilder = new PromptBuilder(db);
    this.taskQueue = new TaskQueue(db, (agentId, task) =>
      this.executeTask(agentId, task),
    );

    this.startSchedulerLoop();
    this.startMonitorLoop();
  }

  // ============ 核心调度接口 ============

  async submitTask(
    agentIdOrGroup: string,
    projectId: string,
    messageId: string,
    content: string,
    priority: number = 5,
    depth: number = 0,
  ): Promise<{
    success: boolean;
    position: number;
    estimatedTime: number;
    assignedAgent?: string;
    executionId?: string;
  }> {
    if (depth >= this.MAX_MENTION_DEPTH) {
      console.warn(
        `Mention chain depth ${depth} >= ${this.MAX_MENTION_DEPTH}, rejecting task for ${agentIdOrGroup}`,
      );
      return { success: false, position: -1, estimatedTime: -1 };
    }

    const isInstanceGroup = agentIdOrGroup.startsWith("ig-");

    let targetAgentId: string | null;

    if (isInstanceGroup) {
      targetAgentId = await this.taskQueue.selectAgentFromGroup(agentIdOrGroup);
      if (!targetAgentId) {
        return { success: false, position: -1, estimatedTime: -1 };
      }
    } else {
      targetAgentId = agentIdOrGroup;
    }

    if (!this.taskQueue.hasWorker(targetAgentId)) {
      await this.taskQueue.initWorker(targetAgentId);
    }

    const existingTask = this.taskQueue.findExistingTask(
      targetAgentId,
      messageId,
    );
    if (existingTask) {
      return {
        success: true,
        position: this.taskQueue.getQueuePosition(
          targetAgentId,
          existingTask.id,
        ),
        estimatedTime: this.taskQueue.estimateWaitTime(
          targetAgentId,
          existingTask.id,
        ),
        assignedAgent: targetAgentId,
        executionId: existingTask.executionId,
      };
    }

    const executionId = await this.createExecutionRecord(
      targetAgentId,
      projectId,
      messageId,
      content,
    );

    const task: AgentTask = {
      id: `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      agentId: targetAgentId,
      projectId,
      messageId,
      content,
      priority: Math.max(1, Math.min(10, priority)),
      createdAt: new Date(),
      retryCount: 0,
      maxRetries: this.MAX_RETRIES,
      executionId,
      depth,
    };

    this.taskQueue.enqueue(targetAgentId, task);

    broadcastToProject(projectId, {
      type: "agent_queued",
      agentId: targetAgentId,
      executionId,
      position: this.taskQueue.getQueuePosition(targetAgentId, task.id),
    });

    this.taskQueue.tryScheduleNext(targetAgentId);

    return {
      success: true,
      position: this.taskQueue.getQueuePosition(targetAgentId, task.id),
      estimatedTime: this.taskQueue.estimateWaitTime(targetAgentId, task.id),
      assignedAgent: targetAgentId,
      executionId,
    };
  }

  async getAgentStatus(agentId: string): Promise<{
    status: "idle" | "working" | "queued";
    currentTask?: AgentTask;
    queueLength: number;
    totalProcessed: number;
    avgProcessingTime: number;
    instanceGroup?: string;
  }> {
    const worker = this.taskQueue.getWorker(agentId);
    const agent = await this.db
      .getDb()
      .get("SELECT instance_group FROM agents WHERE id = ?", [agentId]);

    if (!worker) {
      return {
        status: "idle",
        queueLength: 0,
        totalProcessed: 0,
        avgProcessingTime: 0,
        instanceGroup: agent?.instance_group,
      };
    }

    const queue = this.taskQueue.getQueue(agentId);

    return {
      status: worker.isBusy ? "working" : queue.length > 0 ? "queued" : "idle",
      currentTask: worker.currentTask || undefined,
      queueLength: queue.length,
      totalProcessed: worker.totalProcessed,
      avgProcessingTime: 0,
      instanceGroup: agent?.instance_group,
    };
  }

  async getInstanceGroupStatus(instanceGroup: string): Promise<{
    agents: { agentId: string; status: string; queueLength: number }[];
    totalQueue: number;
    busyCount: number;
    idleCount: number;
  }> {
    const agents = await this.db
      .getDb()
      .all("SELECT id FROM agents WHERE instance_group = ?", [instanceGroup]);

    const result = {
      agents: [] as { agentId: string; status: string; queueLength: number }[],
      totalQueue: 0,
      busyCount: 0,
      idleCount: 0,
    };

    for (const agent of agents) {
      const status = await this.getAgentStatus(agent.id);
      result.agents.push({
        agentId: agent.id,
        status: status.status,
        queueLength: status.queueLength,
      });
      result.totalQueue += status.queueLength;
      if (status.status === "working") result.busyCount++;
      else result.idleCount++;
    }

    return result;
  }

  async cancelTask(taskId: string): Promise<boolean> {
    const cancelled = this.taskQueue.cancelTask(taskId);
    if (!cancelled) return false;

    const { agentId, task } = cancelled;

    if (task.executionId) {
      await this.updateExecutionStatus(task.executionId, "cancelled");
    }

    broadcastToProject(task.projectId, {
      type: "agent_task_cancelled",
      agentId,
      taskId,
    });

    return true;
  }

  async getExecutionHistory(
    agentId?: string,
    projectId?: string,
    limit: number = 50,
    offset: number = 0,
  ): Promise<AgentExecution[]> {
    let query = `
      SELECT e.*, a.name as agent_name, p.name as project_name
      FROM agent_executions e
      LEFT JOIN agents a ON e.agent_id = a.id
      LEFT JOIN projects p ON e.project_id = p.id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (agentId) {
      query += " AND e.agent_id = ?";
      params.push(agentId);
    }

    if (projectId) {
      query += " AND e.project_id = ?";
      params.push(projectId);
    }

    query += " ORDER BY e.created_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    return await this.db.getDb().all(query, params);
  }

  async getExecutionDetail(executionId: string): Promise<{
    execution: AgentExecution | null;
    logs: any[];
  }> {
    const execution = await this.db.getDb().get(
      `SELECT e.*, a.name as agent_name, p.name as project_name
       FROM agent_executions e
       LEFT JOIN agents a ON e.agent_id = a.id
       LEFT JOIN projects p ON e.project_id = p.id
       WHERE e.id = ?`,
      [executionId],
    );

    const logs = await this.db
      .getDb()
      .all(
        "SELECT * FROM agent_execution_logs WHERE execution_id = ? ORDER BY created_at",
        [executionId],
      );

    return { execution, logs };
  }

  async getAgentSkills(agentId: string): Promise<any[]> {
    return await this.db
      .getDb()
      .all(
        "SELECT * FROM agent_skills WHERE agent_id = ? ORDER BY skill_name",
        [agentId],
      );
  }

  async updateAgentSkill(
    skillId: string,
    updates: { enabled?: boolean; config?: any },
  ): Promise<boolean> {
    const sets: string[] = [];
    const params: any[] = [];

    if (updates.enabled !== undefined) {
      sets.push("enabled = ?");
      params.push(updates.enabled ? 1 : 0);
    }

    if (updates.config !== undefined) {
      sets.push("config = ?");
      params.push(JSON.stringify(updates.config));
    }

    if (sets.length === 0) return false;

    params.push(skillId);
    await this.db
      .getDb()
      .run(`UPDATE agent_skills SET ${sets.join(", ")} WHERE id = ?`, params);

    return true;
  }

  // ============ 内部调度逻辑 ============

  private async createExecutionRecord(
    agentId: string,
    projectId: string,
    messageId: string,
    input: string,
  ): Promise<string> {
    const id = `exec-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    await this.db.getDb().run(
      `INSERT INTO agent_executions
       (id, agent_id, project_id, message_id, task_id, status, input, tools_used, token_used, latency_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, agentId, projectId, messageId, id, "pending", input, "[]", 0, 0],
    );

    // [问题7] 缓存新记录，同时清理过老的记录
    this.executions.set(id, {
      id,
      agentId,
      projectId,
      messageId,
      taskId: id,
      status: "pending",
      input,
      toolsUsed: [],
      tokenUsed: 0,
      latencyMs: 0,
      createdAt: new Date(),
    });
    this.cleanupExecutionsCache();

    return id;
  }

  // [问题7] 清理 executions Map，防止内存泄漏
  private cleanupExecutionsCache() {
    if (this.executions.size <= this.MAX_EXECUTIONS_CACHE) return;

    const entries = [...this.executions.entries()].sort(
      (a, b) => a[1].createdAt.getTime() - b[1].createdAt.getTime(),
    );

    const toRemove = entries.length - this.MAX_EXECUTIONS_CACHE;
    for (let i = 0; i < toRemove; i++) {
      const status = entries[i][1].status;
      // 只清理已完成/失败/取消的记录
      if (
        status === "completed" ||
        status === "failed" ||
        status === "cancelled"
      ) {
        this.executions.delete(entries[i][0]);
      }
    }
  }

  private async updateExecutionStatus(
    executionId: string,
    status: string,
    updates?: Partial<AgentExecution>,
  ) {
    const sets: string[] = ["status = ?"];
    const params: any[] = [status];

    if (updates?.output !== undefined) {
      sets.push("output = ?");
      params.push(updates.output);
    }

    if (updates?.error !== undefined) {
      sets.push("error = ?");
      params.push(updates.error);
    }

    if (updates?.toolsUsed !== undefined) {
      sets.push("tools_used = ?");
      params.push(JSON.stringify(updates.toolsUsed));
    }

    if (updates?.tokenUsed !== undefined) {
      sets.push("token_used = ?");
      params.push(updates.tokenUsed);
    }

    if (updates?.latencyMs !== undefined) {
      sets.push("latency_ms = ?");
      params.push(updates.latencyMs);
    }

    if (status === "running") {
      sets.push("started_at = CURRENT_TIMESTAMP");
    }

    if (
      status === "completed" ||
      status === "failed" ||
      status === "cancelled"
    ) {
      sets.push("completed_at = CURRENT_TIMESTAMP");
    }

    params.push(executionId);

    await this.db
      .getDb()
      .run(
        `UPDATE agent_executions SET ${sets.join(", ")} WHERE id = ?`,
        params,
      );

    // 同步更新内存缓存
    const cached = this.executions.get(executionId);
    if (cached) {
      cached.status = status as any;
    }
  }

  private async addExecutionLog(
    executionId: string,
    stepType: string,
    content: string,
    metadata?: any,
  ) {
    await this.db.getDb().run(
      `INSERT INTO agent_execution_logs (id, execution_id, step_type, step_content, metadata)
       VALUES (?, ?, ?, ?, ?)`,
      [
        `log-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        executionId,
        stepType,
        content,
        metadata ? JSON.stringify(metadata) : null,
      ],
    );
  }

  private async executeTask(agentId: string, task: AgentTask) {
    const startTime = Date.now();
    const worker = this.taskQueue.getWorker(agentId)!;
    worker.isBusy = true;
    worker.currentTask = task;
    worker.lastActivity = new Date();

    await this.db
      .getDb()
      .run("UPDATE agents SET status = ? WHERE id = ?", ["working", agentId]);

    await this.updateExecutionStatus(task.executionId!, "running");

    broadcastToProject(task.projectId, {
      type: "agent_status",
      agentId,
      status: "working",
      taskId: task.id,
      executionId: task.executionId,
    });

    try {
      await this.addExecutionLog(task.executionId!, "thought", "开始处理任务", {
        agentId,
        projectId: task.projectId,
        input: task.content.substring(0, 200),
      });

      // [问题16] 使用 AbortController 实现真正的任务中止
      const abortController = new AbortController();
      const timeoutId = setTimeout(
        () => abortController.abort(),
        this.DEFAULT_TIMEOUT,
      );

      try {
        const result = await this.processAgentTask(
          agentId,
          task,
          abortController.signal,
        );
        clearTimeout(timeoutId);

        const latencyMs = Date.now() - startTime;
        worker.totalProcessed++;

        await this.updateExecutionStatus(task.executionId!, "completed", {
          output: result.content,
          toolsUsed: result.toolsUsed,
          latencyMs,
        });

        await this.addExecutionLog(
          task.executionId!,
          "observation",
          "任务完成",
          {
            output: result.content.substring(0, 200),
            latencyMs,
          },
        );
      } catch (error: any) {
        clearTimeout(timeoutId);
        if (abortController.signal.aborted) {
          throw new Error("Task timeout");
        }
        throw error;
      }
    } catch (error: any) {
      const latencyMs = Date.now() - startTime;
      console.error(`Agent ${agentId} task failed:`, error);

      await this.addExecutionLog(task.executionId!, "error", error.message, {
        retryCount: task.retryCount,
      });

      // [问题8] 重试前检查 worker/task 状态
      if (task.retryCount < task.maxRetries) {
        task.retryCount++;
        console.log(`Retrying task ${task.id}, attempt ${task.retryCount}`);

        setTimeout(
          () => {
            const currentWorker = this.taskQueue.getWorker(agentId);
            // 确保 worker 还存在且任务没被取消
            if (!currentWorker) return;
            const queue = this.taskQueue.getQueue(agentId);
            const alreadyQueued = queue.some((t) => t.id === task.id);
            if (alreadyQueued) return;

            this.taskQueue.enqueue(agentId, task);
            this.taskQueue.tryScheduleNext(agentId);
          },
          Math.pow(2, task.retryCount) * 1000,
        );

        return;
      } else {
        await this.updateExecutionStatus(task.executionId!, "failed", {
          error: error.message,
          latencyMs,
        });
        await this.sendAgentErrorMessage(task, error.message);
      }
    } finally {
      worker.isBusy = false;
      worker.currentTask = null;
      worker.lastActivity = new Date();

      await this.db
        .getDb()
        .run("UPDATE agents SET status = ? WHERE id = ?", ["idle", agentId]);

      broadcastToProject(task.projectId, {
        type: "agent_status",
        agentId,
        status: "idle",
        executionId: task.executionId,
      });

      setImmediate(() => this.taskQueue.tryScheduleNext(agentId));
    }
  }

  private async processAgentTask(
    agentId: string,
    task: AgentTask,
    signal?: AbortSignal,
  ) {
    const agent = await this.db
      .getDb()
      .get("SELECT * FROM agents WHERE id = ?", [agentId]);

    if (!agent) throw new Error("Agent not found");

    const project = await this.db
      .getDb()
      .get("SELECT * FROM projects WHERE id = ?", [task.projectId]);

    const skills = await this.getEnabledSkills(agentId);

    const recentMessages = await this.db.getDb().all(
      `
      SELECT m.content, m.author_type, COALESCE(u.name, a.name) as author_name
      FROM messages m
      LEFT JOIN users u ON m.author_id = u.id AND m.author_type = 'user'
      LEFT JOIN agents a ON m.author_id = a.id AND m.author_type = 'agent'
      WHERE m.project_id = ?
      ORDER BY m.created_at DESC
      LIMIT 20
    `,
      [task.projectId],
    );

    const response = await this.generateResponse(
      agent,
      project,
      task.content,
      recentMessages.reverse(),
      skills,
      project?.team_id,
      task.executionId,
      signal,
    );

    const agentMessageId = `msg-${Date.now()}`;
    await this.db
      .getDb()
      .run(
        "INSERT INTO messages (id, project_id, author_id, author_type, content, mentions) VALUES (?, ?, ?, ?, ?, ?)",
        [
          agentMessageId,
          task.projectId,
          agentId,
          "agent",
          response.content,
          JSON.stringify(response.mentions || []),
        ],
      );

    const message = await this.db.getDb().get(
      `
      SELECT m.*, a.name as author_name, a.avatar as author_avatar
      FROM messages m
      LEFT JOIN agents a ON m.author_id = a.id
      WHERE m.id = ?
    `,
      [agentMessageId],
    );

    broadcastToProject(task.projectId, { type: "message", message });

    if (response.mentions?.length) {
      for (const mentionId of response.mentions) {
        if (mentionId.startsWith("agent-") && mentionId !== agentId) {
          this.submitTask(
            mentionId,
            task.projectId,
            agentMessageId,
            response.content,
            5,
            task.depth + 1,
          );
        }
      }
    }

    return {
      content: response.content,
      toolsUsed: response.toolsUsed || [],
    };
  }

  private async getEnabledSkills(agentId: string): Promise<string[]> {
    const skills = await this.db
      .getDb()
      .all(
        "SELECT skill_key FROM agent_skills WHERE agent_id = ? AND enabled = 1",
        [agentId],
      );
    return skills.map((s: any) => s.skill_key);
  }

  private static readonly PROVIDER_ENV: Record<
    string,
    { apiKey: string; baseURL: string; defaultBase?: string }
  > = {
    openai: { apiKey: "OPENAI_API_KEY", baseURL: "OPENAI_BASE_URL" },
    anthropic: {
      apiKey: "ANTHROPIC_API_KEY",
      baseURL: "ANTHROPIC_BASE_URL",
      defaultBase: "https://api.anthropic.com/v1",
    },
    gemini: { apiKey: "GEMINI_API_KEY", baseURL: "GEMINI_BASE_URL" },
    deepseek: {
      apiKey: "DEEPSEEK_API_KEY",
      baseURL: "DEEPSEEK_BASE_URL",
      defaultBase: "https://api.deepseek.com",
    },
  };

  private getLLMClient(agent: any): ILLMClient {
    const provider = agent.model_provider || "openai";
    if (provider === "openai") return this.defaultLLMClient;

    const env = AgentScheduler.PROVIDER_ENV[provider];
    const apiKey = env && process.env[env.apiKey];
    if (!apiKey) return this.defaultLLMClient;

    return createLLMClient(provider, {
      apiKey,
      baseURL: (env && process.env[env.baseURL]) || env?.defaultBase,
    });
  }

  private isMockMode(agent?: any): boolean {
    const provider = agent?.model_provider || "openai";
    const env = AgentScheduler.PROVIDER_ENV[provider];
    const apiKey = env && process.env[env.apiKey];
    return !apiKey || apiKey === "sk-test";
  }

  private readonly MAX_TOOL_ROUNDS = 10;

  private async generateResponse(
    agent: any,
    project: any,
    userMessage: string,
    context: any[],
    enabledSkills: string[],
    teamId?: string,
    executionId?: string,
    signal?: AbortSignal,
  ): Promise<{ content: string; mentions?: string[]; toolsUsed?: string[] }> {
    if (this.isMockMode(agent)) {
      return this.mockResponse(agent.role, teamId);
    }

    const client = this.getLLMClient(agent);
    const systemPrompt = await this.promptBuilder.buildSystemPrompt(
      agent,
      project,
      enabledSkills,
    );
    const tools = this.toolExecutor.getToolDefinitions(enabledSkills);

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...context.map(
        (msg: any): ChatMessage => ({
          role: msg.author_type === "agent" ? "assistant" : "user",
          content: `${msg.author_name}: ${msg.content}`,
        }),
      ),
      { role: "user", content: userMessage },
    ];

    const toolsUsed: string[] = [];
    const logFn = executionId
      ? (stepType: string, content: string, metadata?: any) =>
          this.addExecutionLog(executionId, stepType, content, metadata)
      : undefined;
    const projectId = project?.id;
    const agentId = agent.id;

    try {
      // ReAct 循环：最多 MAX_TOOL_ROUNDS 轮工具调用
      for (let round = 0; round < this.MAX_TOOL_ROUNDS; round++) {
        const response = await client.chat(messages, {
          model: agent.model_name || "gpt-4o-mini",
          tools: tools.length > 0 ? tools : undefined,
          maxTokens: 2000,
          temperature: 0.7,
          signal,
        });

        // 无 tool_calls → 流式最终回复
        if (!response.toolCalls?.length) {
          // 用流式重新生成最终回复
          const finalContent = await this.streamFinalResponse(
            client,
            messages,
            agent,
            projectId,
            agentId,
            signal,
          );
          const mentions = await this.parseMentions(finalContent, teamId);
          return { content: finalContent, mentions, toolsUsed };
        }

        // 有 tool_calls → 执行工具，结果追加到 messages，继续循环
        for (const tc of response.toolCalls) {
          toolsUsed.push(tc.functionName);
        }

        if (logFn) {
          await logFn(
            "thought",
            `ReAct round ${round + 1}: 调用 ${response.toolCalls.map((tc) => tc.functionName).join(", ")}`,
            {
              round: round + 1,
              tools: response.toolCalls.map((tc) => tc.functionName),
            },
          );
        }

        const toolResults = await this.toolExecutor.executeTools(
          response.toolCalls,
          projectId,
          logFn,
        );

        messages.push({
          role: "assistant",
          content: response.content,
          toolCalls: response.toolCalls,
        });
        for (const result of toolResults) {
          messages.push({
            role: "tool",
            content: result.content,
            toolCallId: result.toolCallId,
          });
        }
      }

      // 超过最大轮数，流式生成最终回复
      if (logFn) {
        await logFn(
          "thought",
          `已达 ${this.MAX_TOOL_ROUNDS} 轮工具调用上限，生成最终回复`,
        );
      }
      const finalContent = await this.streamFinalResponse(
        client,
        messages,
        agent,
        projectId,
        agentId,
        signal,
      );
      const mentions = await this.parseMentions(finalContent, teamId);
      return { content: finalContent, mentions, toolsUsed };
    } catch (err) {
      console.error("LLM API error:", err);
      return this.mockResponse(agent.role, teamId);
    }
  }

  private async streamFinalResponse(
    client: ILLMClient,
    messages: ChatMessage[],
    agent: any,
    projectId?: string,
    agentId?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    let fullContent = "";

    // 通知前端开始流式
    if (projectId) {
      broadcastToProject(projectId, {
        type: "agent_stream_start",
        agentId,
      });
    }

    try {
      for await (const chunk of client.chatStream(messages, {
        model: agent.model_name || "gpt-4o-mini",
        maxTokens: 2000,
        temperature: 0.7,
        signal,
      })) {
        if (chunk.type === "content" && chunk.content) {
          fullContent += chunk.content;
          if (projectId) {
            broadcastToProject(projectId, {
              type: "agent_stream",
              agentId,
              content: chunk.content,
            });
          }
        }
      }
    } finally {
      if (projectId) {
        broadcastToProject(projectId, {
          type: "agent_stream_end",
          agentId,
          content: fullContent,
        });
      }
    }

    return fullContent;
  }

  private async sendAgentErrorMessage(task: AgentTask, errorMessage: string) {
    const content = `抱歉，处理您的请求时出错了（已重试${task.maxRetries}次）。错误信息：${errorMessage}`;

    const agentMessageId = `msg-${Date.now()}`;
    await this.db
      .getDb()
      .run(
        "INSERT INTO messages (id, project_id, author_id, author_type, content, mentions) VALUES (?, ?, ?, ?, ?, ?)",
        [agentMessageId, task.projectId, task.agentId, "agent", content, "[]"],
      );

    const message = await this.db.getDb().get(
      `
      SELECT m.*, a.name as author_name, a.avatar as author_avatar
      FROM messages m
      LEFT JOIN agents a ON m.author_id = a.id
      WHERE m.id = ?
    `,
      [agentMessageId],
    );

    broadcastToProject(task.projectId, { type: "message", message });
  }

  private async mockResponse(
    role: string,
    teamId?: string,
  ): Promise<{ content: string; mentions?: string[]; toolsUsed?: string[] }> {
    const responses: Record<string, string[]> = {
      pm: ["明白了，我来梳理一下需求。@架构师-AI 看看技术方案？"],
      architect: ["技术上可行。建议用微服务架构。@开发-AI 来实现吧？"],
      developer: ["收到，我来实现这个功能。@测试-AI 准备好测试环境"],
      tester: ["测试完成！发现问题。@开发-AI 修复一下"],
    };

    const roleResponses = responses[role] || responses.pm;
    const content =
      roleResponses[Math.floor(Math.random() * roleResponses.length)];
    const mentions = await this.parseMentions(content, teamId);

    return { content, mentions, toolsUsed: [] };
  }

  private async parseMentions(
    content: string,
    teamId?: string,
  ): Promise<string[]> {
    const mentions: string[] = [];

    let teamAgents;
    if (teamId) {
      teamAgents = await this.db
        .getDb()
        .all("SELECT id, name FROM agents WHERE team_id = ?", [teamId]);
    }

    if (teamAgents) {
      for (const agent of teamAgents) {
        if (
          content.includes(`@${agent.name}`) ||
          content.includes(`@${agent.id}`)
        ) {
          mentions.push(agent.id);
        }
      }
    }

    return mentions;
  }

  private startSchedulerLoop() {
    setInterval(() => {
      for (const agentId of this.taskQueue.workerIds()) {
        this.taskQueue.tryScheduleNext(agentId);
      }
    }, 1000);
  }

  // [问题9] 监控循环中 async + await
  private startMonitorLoop() {
    setInterval(async () => {
      const now = new Date();
      for (const [agentId, worker] of this.taskQueue.workerEntries()) {
        if (worker.isBusy && worker.currentTask) {
          const taskDuration = now.getTime() - worker.lastActivity.getTime();
          if (taskDuration > 10 * 60 * 1000) {
            console.warn(`Agent ${agentId} appears stuck, resetting...`);
            worker.isBusy = false;
            worker.currentTask = null;
            await this.db
              .getDb()
              .run("UPDATE agents SET status = ? WHERE id = ?", [
                "idle",
                agentId,
              ]);
            this.taskQueue.tryScheduleNext(agentId);
          }
        }
      }
    }, 30000);
  }
}

export default AgentScheduler;
