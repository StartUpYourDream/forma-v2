import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';

export default class FormaDB {
  private db: Database<sqlite3.Database> | null = null;

  async init() {
    // [问题20] 使用环境变量配置数据库路径
    const dbPath = process.env.DB_PATH || './data/forma.db';
    this.db = await open({
      filename: dbPath,
      driver: sqlite3.Database
    });

    // [问题17] 启用外键约束
    await this.db.exec('PRAGMA foreign_keys = ON');

    await this.createTables();
    await this.seedData();
    console.log('✅ Database initialized (v3 - With Agent Skills & Load Balancing)');
  }

  private async createTables() {
    await this.db!.exec(`
      -- Users
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        avatar TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- Teams
      CREATE TABLE IF NOT EXISTS teams (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (owner_id) REFERENCES users(id)
      );

      -- Team Members (users + agents)
      CREATE TABLE IF NOT EXISTS team_members (
        team_id TEXT,
        member_id TEXT,
        member_type TEXT CHECK(member_type IN ('user', 'agent')),
        role TEXT,
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (team_id, member_id),
        FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
      );

      -- Agents (支持多实例)
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        team_id TEXT,
        name TEXT NOT NULL,
        role TEXT NOT NULL,              -- pm, architect, developer, tester, custom
        avatar TEXT,
        system_prompt TEXT,
        model_provider TEXT DEFAULT 'openai',
        model_name TEXT DEFAULT 'gpt-4o-mini',
        status TEXT DEFAULT 'idle',      -- idle, working, offline
        instance_group TEXT,             -- 负载均衡组ID，同角色多个Agent共享
        max_concurrent INTEGER DEFAULT 1, -- 该Agent实例最大并发数
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
      );

      -- Agent 技能配置
      CREATE TABLE IF NOT EXISTS agent_skills (
        id TEXT PRIMARY KEY,
        agent_id TEXT,
        skill_key TEXT NOT NULL,         -- 技能标识：file_read, file_write, code_generate...
        skill_name TEXT NOT NULL,        -- 显示名称
        skill_description TEXT,
        enabled BOOLEAN DEFAULT 1,
        config JSON,                     -- 技能配置参数
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
      );

      -- Agent 执行历史
      CREATE TABLE IF NOT EXISTS agent_executions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL,            -- pending, running, completed, failed, cancelled
        input TEXT,                      -- 输入内容
        output TEXT,                     -- 输出内容
        error TEXT,                      -- 错误信息
        tools_used JSON,                 -- 使用的工具列表
        token_used INTEGER,              -- Token消耗
        latency_ms INTEGER,              -- 执行耗时
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        started_at DATETIME,
        completed_at DATETIME,
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      -- Agent 执行日志（详细步骤）
      CREATE TABLE IF NOT EXISTS agent_execution_logs (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        step_type TEXT NOT NULL,         -- thought, action, observation, error
        step_content TEXT NOT NULL,
        metadata JSON,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (execution_id) REFERENCES agent_executions(id) ON DELETE CASCADE
      );

      -- Projects
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
      );

      -- Messages
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author_type TEXT CHECK(author_type IN ('user', 'agent', 'system')),
        content TEXT NOT NULL,
        mentions TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      -- Files
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        path TEXT NOT NULL,
        content TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(project_id, path),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      -- Project Context
      CREATE TABLE IF NOT EXISTS project_context (
        project_id TEXT PRIMARY KEY,
        requirements TEXT,
        tech_stack TEXT,
        architecture TEXT,
        coding_standards TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      -- 创建索引
      CREATE INDEX IF NOT EXISTS idx_agents_team ON agents(team_id);
      CREATE INDEX IF NOT EXISTS idx_agents_role ON agents(role);
      CREATE INDEX IF NOT EXISTS idx_agents_instance_group ON agents(instance_group);
      CREATE INDEX IF NOT EXISTS idx_agent_skills_agent ON agent_skills(agent_id);
      CREATE INDEX IF NOT EXISTS idx_executions_agent ON agent_executions(agent_id);
      CREATE INDEX IF NOT EXISTS idx_executions_project ON agent_executions(project_id);
      CREATE INDEX IF NOT EXISTS idx_executions_status ON agent_executions(status);
      CREATE INDEX IF NOT EXISTS idx_logs_execution ON agent_execution_logs(execution_id);
    `);
  }

  private async seedData() {
    // Create default user
    await this.db!.run(
      'INSERT OR IGNORE INTO users (id, name, email, avatar) VALUES (?, ?, ?, ?)',
      ['user-1', 'Votan', 'votan@forma.ai', 'https://api.dicebear.com/7.x/avataaars/svg?seed=votan']
    );

    // Create multiple teams for testing
    const teams = [
      { id: 'team-1', name: 'JustDo', owner: 'user-1' },
      { id: 'team-2', name: 'AcmeCorp', owner: 'user-1' }
    ];

    for (const team of teams) {
      await this.db!.run(
        'INSERT OR IGNORE INTO teams (id, name, owner_id) VALUES (?, ?, ?)',
        [team.id, team.name, team.owner]
      );

      await this.db!.run(
        'INSERT OR IGNORE INTO team_members (team_id, member_id, member_type, role) VALUES (?, ?, ?, ?)',
        [team.id, 'user-1', 'user', team.id === 'team-1' ? 'owner' : 'member']
      );

      // 创建每个团队的默认 Agent（带实例组，支持负载均衡）
      const agentConfigs = [
        {
          role: 'pm',
          name: '产品经理-AI',
          instanceCount: 1,
          skills: ['read_file', 'write_file', 'list_files', 'get_project_context', 'requirement_analysis']
        },
        {
          role: 'architect',
          name: '架构师-AI',
          instanceCount: 1,
          skills: ['read_file', 'write_file', 'list_files', 'get_project_context', 'architecture_design']
        },
        {
          role: 'developer',
          name: '开发-AI',
          instanceCount: 2, // 2个实例，负载均衡
          skills: ['read_file', 'write_file', 'list_files', 'get_project_context', 'code_generate', 'code_review', 'debug']
        },
        {
          role: 'tester',
          name: '测试-AI',
          instanceCount: 1,
          skills: ['read_file', 'write_file', 'list_files', 'get_project_context', 'test_generate', 'test_execute']
        }
      ];

      for (const config of agentConfigs) {
        const instanceGroup = `ig-${team.id}-${config.role}`;

        // 创建多个实例
        for (let i = 0; i < config.instanceCount; i++) {
          const agentId = `agent-${config.role}-${team.id}-${i}`;
          const agentName = config.instanceCount > 1
            ? `${config.name}-${i + 1}`
            : config.name;

          await this.db!.run(
            `INSERT OR IGNORE INTO agents (id, team_id, name, role, avatar, system_prompt, instance_group, max_concurrent)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [agentId, team.id, agentName, config.role,
             `https://api.dicebear.com/7.x/bottts/svg?seed=${agentId}`,
             `You are ${agentName}`,
             instanceGroup,
             1]
          );

          await this.db!.run(
            'INSERT OR IGNORE INTO team_members (team_id, member_id, member_type, role) VALUES (?, ?, ?, ?)',
            [team.id, agentId, 'agent', config.role]
          );

          // 添加技能
          for (const skillKey of config.skills) {
            await this.addSkillIfNotExists(agentId, skillKey);
          }
        }
      }

      // Create default projects
      const projects = team.id === 'team-1'
        ? [
            { id: 'project-1', name: 'Forma', desc: 'AI团队协作平台' },
            { id: 'project-2', name: 'Tlist', desc: '待办事项应用' }
          ]
        : [
            { id: 'project-3', name: 'WebApp', desc: '企业官网' },
            { id: 'project-4', name: 'MobileApp', desc: '移动客户端' }
          ];

      for (const proj of projects) {
        await this.db!.run(
          'INSERT OR IGNORE INTO projects (id, team_id, name, description) VALUES (?, ?, ?, ?)',
          [proj.id, team.id, proj.name, proj.desc]
        );

        await this.db!.run(
          'INSERT OR IGNORE INTO project_context (project_id) VALUES (?)',
          [proj.id]
        );

        await this.db!.run(
          `INSERT OR IGNORE INTO messages (id, project_id, author_id, author_type, content, mentions)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            `msg-welcome-${proj.id}`,
            proj.id,
            'system',
            'system',
            `欢迎使用 ${proj.name}！\n\n${proj.desc}\n\n开始和Agent协作吧！`,
            '[]'
          ]
        );
      }
    }
  }

  private async addSkillIfNotExists(agentId: string, skillKey: string) {
    const skillConfigs: Record<string, { name: string; description: string; config?: any }> = {
      read_file: {
        name: '读取文件',
        description: '读取项目中的文件内容'
      },
      write_file: {
        name: '写入文件',
        description: '创建或修改项目文件'
      },
      list_files: {
        name: '列出文件',
        description: '查看项目文件列表'
      },
      get_project_context: {
        name: '获取项目上下文',
        description: '获取项目技术栈、需求等信息'
      },
      code_generate: {
        name: '代码生成',
        description: '根据需求生成代码',
        config: { max_lines: 200, languages: ['typescript', 'javascript', 'python'] }
      },
      code_review: {
        name: '代码审查',
        description: '审查代码质量并提出建议'
      },
      debug: {
        name: '调试',
        description: '分析并修复代码中的问题'
      },
      requirement_analysis: {
        name: '需求分析',
        description: '分析用户需求并输出PRD'
      },
      architecture_design: {
        name: '架构设计',
        description: '设计系统架构方案'
      },
      test_generate: {
        name: '生成测试',
        description: '为功能生成测试用例'
      },
      test_execute: {
        name: '执行测试',
        description: '运行测试并报告结果'
      }
    };

    const existing = await this.db!.get(
      'SELECT id FROM agent_skills WHERE agent_id = ? AND skill_key = ?',
      [agentId, skillKey]
    );

    if (!existing) {
      const config = skillConfigs[skillKey];
      await this.db!.run(
        `INSERT INTO agent_skills (id, agent_id, skill_key, skill_name, skill_description, config)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          `skill-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          agentId,
          skillKey,
          config?.name || skillKey,
          config?.description || '',
          config?.config ? JSON.stringify(config.config) : null
        ]
      );
    }
  }

  getDb() {
    return this.db!;
  }

  // [问题21] 提供 close 方法供 graceful shutdown 使用
  async close() {
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
  }
}
