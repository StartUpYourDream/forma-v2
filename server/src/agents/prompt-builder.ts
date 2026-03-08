import type FormaDB from "../db.js";

// Tool Skills → 映射为 function tools（由 ToolExecutor 处理）
const TOOL_SKILLS = new Set([
  "read_file",
  "write_file",
  "list_files",
  "get_project_context",
]);

// Prompt Skills → 通过 system prompt 注入行为指引
const PROMPT_SKILL_GUIDES: Record<string, string> = {
  code_generate: `【代码生成】
你擅长根据需求生成高质量代码。生成代码时注意：
- 遵循项目的编码规范和技术栈约定
- 代码结构清晰，包含必要的错误处理
- 使用项目中已有的工具函数和组件，避免重复造轮子
- 先用 list_files 和 read_file 了解项目结构，再生成代码`,

  code_review: `【代码审查】
你擅长审查代码质量。审查时关注：
- 逻辑正确性和边界条件处理
- 安全漏洞（注入、XSS、敏感信息泄露等）
- 性能问题（N+1 查询、内存泄漏、不必要的渲染等）
- 可维护性（命名、复杂度、职责单一）
- 给出具体的改进建议和代码示例`,

  debug: `【调试排错】
你擅长定位和修复 Bug。调试时：
- 先理解问题的复现条件和预期行为
- 用 read_file 查看相关代码，追踪数据流
- 分析可能的原因，从最可能的开始排查
- 提供修复方案和验证方法`,

  requirement_analysis: `【需求分析】
你擅长分析和梳理产品需求。分析时：
- 明确功能边界和用户场景
- 识别隐含需求和潜在冲突
- 拆分为可执行的任务项，标注优先级
- 考虑技术可行性和实现成本`,

  architecture_design: `【架构设计】
你擅长设计系统架构。设计时：
- 分析业务需求的规模和复杂度
- 选择合适的架构模式和技术方案
- 定义模块划分、接口契约和数据流
- 考虑扩展性、可维护性和性能`,

  test_generate: `【测试生成】
你擅长编写测试用例。生成测试时：
- 覆盖正常路径和边界条件
- 包含单元测试和集成测试
- Mock 外部依赖，保持测试独立性
- 测试命名清晰描述测试意图`,

  test_execute: `【测试执行】
你擅长执行测试并分析结果。执行时：
- 运行相关测试套件
- 分析失败原因，区分代码 Bug 和测试问题
- 提供修复建议
- 确认修复后回归测试通过`,
};

export class PromptBuilder {
  private db: FormaDB;

  constructor(db: FormaDB) {
    this.db = db;
  }

  async buildSystemPrompt(
    agent: any,
    project: any,
    enabledSkills: string[],
  ): Promise<string> {
    const rolePrompts: Record<string, string> = {
      pm: `你是${agent.name}，一个经验丰富的产品经理。你的职责是理解用户需求、梳理功能点、制定开发计划。`,
      architect: `你是${agent.name}，一个资深系统架构师。你的职责是设计技术方案、选择技术栈、定义系统架构。`,
      developer: `你是${agent.name}，一个全栈开发工程师。你的职责是实现功能、编写代码、修复Bug。`,
      tester: `你是${agent.name}，一个QA测试工程师。你的职责是测试功能、发现Bug、确保产品质量。`,
    };

    let prompt = rolePrompts[agent.role] || rolePrompts.pm;

    if (project) {
      prompt += `\n\n当前项目：${project.name}\n项目描述：${project.description || "暂无描述"}`;
    }

    // 注入 Prompt Skills 的行为指引
    const promptSkills = enabledSkills.filter(
      (s) => !TOOL_SKILLS.has(s) && PROMPT_SKILL_GUIDES[s],
    );
    if (promptSkills.length > 0) {
      prompt += "\n\n【能力专长】\n";
      for (const skill of promptSkills) {
        prompt += PROMPT_SKILL_GUIDES[skill] + "\n";
      }
    }

    // Tool Skills 仅列出名称（实际工具定义由 ToolExecutor 提供）
    const toolSkills = enabledSkills.filter((s) => TOOL_SKILLS.has(s));
    if (toolSkills.length > 0) {
      prompt += "\n\n【可用工具】\n";
      prompt += toolSkills.map((s) => `- ${s}`).join("\n");
      prompt += "\n你可以调用以上工具来读写项目文件、获取项目信息。";
    }

    let projectContext = "";
    if (project?.id) {
      const context = await this.db
        .getDb()
        .get("SELECT * FROM project_context WHERE project_id = ?", [
          project.id,
        ]);

      if (context) {
        const parts = [];
        if (context.tech_stack) parts.push(`技术栈: ${context.tech_stack}`);
        if (context.architecture) parts.push(`架构: ${context.architecture}`);
        if (context.coding_standards)
          parts.push(`编码规范: ${context.coding_standards}`);
        if (context.requirements)
          parts.push(`需求文档: ${context.requirements}`);

        if (parts.length > 0) {
          projectContext = "\n\n【项目上下文】\n" + parts.join("\n");
        }
      }

      const files = await this.db
        .getDb()
        .all(
          "SELECT path FROM files WHERE project_id = ? ORDER BY path LIMIT 20",
          [project.id],
        );

      if (files.length > 0) {
        projectContext +=
          "\n\n【项目文件】\n" + files.map((f: any) => f.path).join("\n");
      }
    }

    prompt += projectContext;
    prompt += `\n\n你可以使用 @用户名 来提及其他团队成员。`;

    return prompt;
  }
}
