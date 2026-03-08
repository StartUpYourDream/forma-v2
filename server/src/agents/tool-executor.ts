import type FormaDB from "../db.js";
import { broadcastToProject } from "../websocket.js";
import type { ToolDefinition, ToolCall, ToolResult } from "./types.js";

export class ToolExecutor {
  private db: FormaDB;

  constructor(db: FormaDB) {
    this.db = db;
  }

  getToolDefinitions(enabledSkills: string[]): ToolDefinition[] {
    const allTools: Record<string, ToolDefinition> = {
      read_file: {
        name: "read_file",
        description: "读取项目中的文件内容",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "文件路径，例如 src/index.ts",
            },
          },
          required: ["path"],
        },
      },
      write_file: {
        name: "write_file",
        description: "写入或创建文件",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "文件路径" },
            content: { type: "string", description: "文件内容" },
          },
          required: ["path", "content"],
        },
      },
      list_files: {
        name: "list_files",
        description: "列出项目中的文件",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "目录路径，不传则列出根目录" },
          },
        },
      },
      get_project_context: {
        name: "get_project_context",
        description: "获取项目技术栈和需求信息",
        parameters: { type: "object", properties: {} },
      },
    };

    return enabledSkills
      .filter((skill) => allTools[skill])
      .map((skill) => allTools[skill]);
  }

  async executeTools(
    toolCalls: ToolCall[],
    projectId?: string,
    onLog?: (
      stepType: string,
      content: string,
      metadata?: any,
    ) => Promise<void>,
  ): Promise<ToolResult[]> {
    const results: ToolResult[] = [];

    for (const toolCall of toolCalls) {
      const args = JSON.parse(toolCall.arguments);
      let result: string;

      try {
        switch (toolCall.functionName) {
          case "read_file":
            result = await this.toolReadFile(args.path, projectId);
            break;
          case "write_file":
            result = await this.toolWriteFile(
              args.path,
              args.content,
              projectId,
            );
            break;
          case "list_files":
            result = await this.toolListFiles(args.path || "", projectId);
            break;
          case "get_project_context":
            result = await this.toolGetProjectContext(projectId);
            break;
          default:
            result = `未知工具: ${toolCall.functionName}`;
        }

        if (onLog) {
          await onLog("action", `执行工具: ${toolCall.functionName}`, {
            tool: toolCall.functionName,
            args,
            result: result.substring(0, 500),
          });
        }
      } catch (err: any) {
        result = `执行失败: ${err.message}`;
        if (onLog) {
          await onLog("error", `工具执行失败: ${toolCall.functionName}`, {
            tool: toolCall.functionName,
            error: err.message,
          });
        }
      }

      results.push({ toolCallId: toolCall.id, content: result });

      if (projectId) {
        broadcastToProject(projectId, {
          type: "tool_execution",
          tool: toolCall.functionName,
          args,
          result: result.substring(0, 1000),
        });
      }
    }

    return results;
  }

  // ============ 工具实现 ============

  private async toolReadFile(
    path: string,
    projectId?: string,
  ): Promise<string> {
    if (!projectId) return "错误：未设置项目";
    const file = await this.db
      .getDb()
      .get("SELECT content FROM files WHERE project_id = ? AND path = ?", [
        projectId,
        path,
      ]);
    return file ? file.content : `文件不存在: ${path}`;
  }

  private async toolWriteFile(
    path: string,
    content: string,
    projectId?: string,
  ): Promise<string> {
    if (!projectId) return "错误：未设置项目";
    const existing = await this.db
      .getDb()
      .get("SELECT id FROM files WHERE project_id = ? AND path = ?", [
        projectId,
        path,
      ]);

    if (existing) {
      await this.db
        .getDb()
        .run(
          "UPDATE files SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE project_id = ? AND path = ?",
          [content, projectId, path],
        );
    } else {
      await this.db
        .getDb()
        .run(
          "INSERT INTO files (id, project_id, path, content) VALUES (?, ?, ?, ?)",
          [`file-${Date.now()}`, projectId, path, content],
        );
    }

    broadcastToProject(projectId, {
      type: "file_changed",
      path,
      action: existing ? "updated" : "created",
    });

    return `文件已${existing ? "更新" : "创建"}: ${path}`;
  }

  private async toolListFiles(
    path: string,
    projectId?: string,
  ): Promise<string> {
    if (!projectId) return "错误：未设置项目";
    const files = await this.db
      .getDb()
      .all("SELECT path FROM files WHERE project_id = ? ORDER BY path", [
        projectId,
      ]);
    return files.length > 0
      ? files.map((f: any) => f.path).join("\n")
      : "项目中暂无文件";
  }

  private async toolGetProjectContext(projectId?: string): Promise<string> {
    if (!projectId) return "错误：未设置项目";
    const context = await this.db
      .getDb()
      .get("SELECT * FROM project_context WHERE project_id = ?", [projectId]);
    return context
      ? `技术栈: ${context.tech_stack || "未定义"}\n架构: ${context.architecture || "未定义"}`
      : "暂无项目上下文信息";
  }
}
