import { Router } from 'express';
import type FormaDB from '../db.js';
import type { AgentScheduler } from '../agents/scheduler.js';

// [问题15] LIMIT 参数安全上限
const MAX_LIMIT = 200;

function clampLimit(value: any, defaultVal = 50): number {
  const n = Number(value) || defaultVal;
  return Math.min(Math.max(1, n), MAX_LIMIT);
}

// [问题14] 简单的输入验证
function validateRequired(body: any, fields: string[]): string | null {
  for (const field of fields) {
    if (body[field] === undefined || body[field] === null || body[field] === '') {
      return `缺少必填字段: ${field}`;
    }
  }
  return null;
}

function validateStringLength(value: any, field: string, max: number): string | null {
  if (typeof value === 'string' && value.length > max) {
    return `${field} 超过最大长度 ${max}`;
  }
  return null;
}

export function setupRoutes(db: FormaDB, agentScheduler: AgentScheduler) {
  const router = Router();

  // ============ Auth ============
  router.get('/me', async (req, res) => {
    const user = await db.getDb().get('SELECT * FROM users WHERE id = ?', ['user-1']);
    res.json(user);
  });

  // ============ Teams ============
  router.get('/teams', async (req, res) => {
    const teams = await db.getDb().all('SELECT * FROM teams');
    res.json(teams);
  });

  router.get('/teams/:id', async (req, res) => {
    const team = await db.getDb().get('SELECT * FROM teams WHERE id = ?', [req.params.id]);
    res.json(team);
  });

  router.post('/teams', async (req, res) => {
    const { name, ownerId = 'user-1' } = req.body;

    // [问题14] 输入验证
    const err = validateRequired(req.body, ['name']);
    if (err) return res.status(400).json({ error: err });
    const lenErr = validateStringLength(name, 'name', 100);
    if (lenErr) return res.status(400).json({ error: lenErr });

    const teamId = `team-${Date.now()}`;

    await db.getDb().run(
      'INSERT INTO teams (id, name, owner_id) VALUES (?, ?, ?)',
      [teamId, name, ownerId]
    );

    await db.getDb().run(
      'INSERT INTO team_members (team_id, member_id, member_type, role) VALUES (?, ?, ?, ?)',
      [teamId, ownerId, 'user', 'owner']
    );

    const agentConfigs = [
      { role: 'pm', name: '产品经理-AI', instanceCount: 1 },
      { role: 'architect', name: '架构师-AI', instanceCount: 1 },
      { role: 'developer', name: '开发-AI', instanceCount: 2 },
      { role: 'tester', name: '测试-AI', instanceCount: 1 }
    ];

    for (const config of agentConfigs) {
      const instanceGroup = `ig-${teamId}-${config.role}`;

      for (let i = 0; i < config.instanceCount; i++) {
        const agentId = `agent-${config.role}-${teamId}-${i}`;
        const agentName = config.instanceCount > 1
          ? `${config.name}-${i + 1}`
          : config.name;

        await db.getDb().run(
          `INSERT INTO agents (id, team_id, name, role, avatar, system_prompt, instance_group)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [agentId, teamId, agentName, config.role,
           `https://api.dicebear.com/7.x/bottts/svg?seed=${agentId}`,
           `You are ${agentName}`,
           instanceGroup]
        );

        await db.getDb().run(
          'INSERT INTO team_members (team_id, member_id, member_type, role) VALUES (?, ?, ?, ?)',
          [teamId, agentId, 'agent', config.role]
        );
      }
    }

    const team = await db.getDb().get('SELECT * FROM teams WHERE id = ?', [teamId]);
    res.json(team);
  });

  // ============ Team Members ============
  router.get('/teams/:id/members', async (req, res) => {
    const { id } = req.params;
    type MemberRow = {
      id: string;
      type: string;
      role: string;
      name: string;
      avatar: string;
      status: string;
      agent_role: string;
      instance_group: string;
    };
    const members = await db.getDb().all<MemberRow>(`
      SELECT
        tm.member_id as id,
        tm.member_type as type,
        tm.role,
        COALESCE(u.name, a.name) as name,
        COALESCE(u.avatar, a.avatar) as avatar,
        COALESCE(a.status, 'online') as status,
        a.role as agent_role,
        a.instance_group
      FROM team_members tm
      LEFT JOIN users u ON tm.member_id = u.id AND tm.member_type = 'user'
      LEFT JOIN agents a ON tm.member_id = a.id AND tm.member_type = 'agent'
      WHERE tm.team_id = ?
      ORDER BY tm.member_type, a.role, a.name
    `, [id]);
    res.json(members);
  });

  // ============ Projects ============
  router.get('/teams/:id/projects', async (req, res) => {
    const projects = await db.getDb().all(
      'SELECT * FROM projects WHERE team_id = ? ORDER BY created_at',
      [req.params.id]
    );
    res.json(projects);
  });

  router.post('/teams/:id/projects', async (req, res) => {
    const { id } = req.params;
    const { name, description } = req.body;

    const err = validateRequired(req.body, ['name']);
    if (err) return res.status(400).json({ error: err });
    const lenErr = validateStringLength(name, 'name', 200);
    if (lenErr) return res.status(400).json({ error: lenErr });

    const projectId = `project-${Date.now()}`;
    await db.getDb().run(
      'INSERT INTO projects (id, team_id, name, description) VALUES (?, ?, ?, ?)',
      [projectId, id, name, description]
    );

    await db.getDb().run(
      'INSERT INTO project_context (project_id) VALUES (?)',
      [projectId]
    );

    const project = await db.getDb().get('SELECT * FROM projects WHERE id = ?', [projectId]);
    res.json(project);
  });

  router.get('/projects/:id', async (req, res) => {
    const project = await db.getDb().get('SELECT * FROM projects WHERE id = ?', [req.params.id]);
    res.json(project);
  });

  // ============ Messages ============
  router.get('/projects/:id/messages', async (req, res) => {
    const { id } = req.params;
    // [问题15] 限制 limit 上限
    const limit = clampLimit(req.query.limit);

    const messages = await db.getDb().all(`
      SELECT
        m.id,
        m.project_id,
        m.author_id,
        m.author_type,
        m.content,
        m.mentions,
        m.created_at,
        COALESCE(u.name, a.name) as author_name,
        COALESCE(u.avatar, a.avatar) as author_avatar
      FROM messages m
      LEFT JOIN users u ON m.author_id = u.id AND m.author_type = 'user'
      LEFT JOIN agents a ON m.author_id = a.id AND m.author_type = 'agent'
      WHERE m.project_id = ?
      ORDER BY m.created_at DESC
      LIMIT ?
    `, [id, limit]);

    res.json(messages.reverse());
  });

  router.post('/projects/:id/messages', async (req, res) => {
    const { id } = req.params;
    const { content, authorId = 'user-1', mentions = [] } = req.body;

    const err = validateRequired(req.body, ['content']);
    if (err) return res.status(400).json({ error: err });
    const lenErr = validateStringLength(content, 'content', 10000);
    if (lenErr) return res.status(400).json({ error: lenErr });

    const messageId = `msg-${Date.now()}`;

    await db.getDb().run(
      'INSERT INTO messages (id, project_id, author_id, author_type, content, mentions) VALUES (?, ?, ?, ?, ?, ?)',
      [messageId, id, authorId, 'user', content, JSON.stringify(mentions)]
    );

    const message = await db.getDb().get('SELECT * FROM messages WHERE id = ?', [messageId]);

    if (mentions.length > 0) {
      for (const mentionId of mentions) {
        if (mentionId.startsWith('agent-') || mentionId.startsWith('ig-')) {
          agentScheduler.submitTask(mentionId, id, messageId, content);
        }
      }
    }

    res.json(message);
  });

  // ============ Agents ============

  router.get('/teams/:id/agents', async (req, res) => {
    const agents = await db.getDb().all(
      'SELECT * FROM agents WHERE team_id = ? ORDER BY role, name',
      [req.params.id]
    );
    res.json(agents);
  });

  router.get('/agents/:id', async (req, res) => {
    const agent = await db.getDb().get('SELECT * FROM agents WHERE id = ?', [req.params.id]);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const status = await agentScheduler.getAgentStatus(req.params.id);

    res.json({ ...agent, ...status });
  });

  router.post('/teams/:id/agents', async (req, res) => {
    const { id: teamId } = req.params;
    const { name, role, model_provider, model_name, system_prompt, instance_group } = req.body;

    const err = validateRequired(req.body, ['name', 'role']);
    if (err) return res.status(400).json({ error: err });

    const agentId = `agent-${Date.now()}`;

    await db.getDb().run(
      `INSERT INTO agents (id, team_id, name, role, avatar, system_prompt, model_provider, model_name, instance_group)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [agentId, teamId, name, role,
       `https://api.dicebear.com/7.x/bottts/svg?seed=${agentId}`,
       system_prompt || `You are ${name}`,
       model_provider || 'openai',
       model_name || 'gpt-4o-mini',
       instance_group || null]
    );

    await db.getDb().run(
      'INSERT INTO team_members (team_id, member_id, member_type, role) VALUES (?, ?, ?, ?)',
      [teamId, agentId, 'agent', role]
    );

    const agent = await db.getDb().get('SELECT * FROM agents WHERE id = ?', [agentId]);
    res.json(agent);
  });

  router.patch('/agents/:id', async (req, res) => {
    const { id } = req.params;
    const { name, role, system_prompt, model_provider, model_name, instance_group, max_concurrent } = req.body;

    await db.getDb().run(
      `UPDATE agents SET
        name = COALESCE(?, name),
        role = COALESCE(?, role),
        system_prompt = COALESCE(?, system_prompt),
        model_provider = COALESCE(?, model_provider),
        model_name = COALESCE(?, model_name),
        instance_group = COALESCE(?, instance_group),
        max_concurrent = COALESCE(?, max_concurrent)
       WHERE id = ?`,
      [name, role, system_prompt, model_provider, model_name, instance_group, max_concurrent, id]
    );

    const agent = await db.getDb().get('SELECT * FROM agents WHERE id = ?', [id]);
    res.json(agent);
  });

  // [问题10] 删除 Agent 时级联清理 agent_executions 和 agent_execution_logs
  router.delete('/agents/:id', async (req, res) => {
    const { id } = req.params;

    // 先删除执行日志（通过子查询找到相关的 execution）
    await db.getDb().run(
      'DELETE FROM agent_execution_logs WHERE execution_id IN (SELECT id FROM agent_executions WHERE agent_id = ?)',
      [id]
    );
    await db.getDb().run('DELETE FROM agent_executions WHERE agent_id = ?', [id]);
    await db.getDb().run('DELETE FROM team_members WHERE member_id = ?', [id]);
    await db.getDb().run('DELETE FROM agent_skills WHERE agent_id = ?', [id]);
    await db.getDb().run('DELETE FROM agents WHERE id = ?', [id]);

    res.json({ success: true });
  });

  // ============ Agent 负载均衡 ============

  router.get('/instance-groups/:groupId/status', async (req, res) => {
    const status = await agentScheduler.getInstanceGroupStatus(req.params.groupId);
    res.json(status);
  });

  // ============ Agent 技能管理 ============

  router.get('/agents/:id/skills', async (req, res) => {
    const skills = await agentScheduler.getAgentSkills(req.params.id);
    res.json(skills);
  });

  router.post('/agents/:id/skills', async (req, res) => {
    const { id: agentId } = req.params;
    const { skill_key, skill_name, skill_description, config } = req.body;

    const err = validateRequired(req.body, ['skill_key', 'skill_name']);
    if (err) return res.status(400).json({ error: err });

    const skillId = `skill-${Date.now()}`;
    await db.getDb().run(
      `INSERT INTO agent_skills (id, agent_id, skill_key, skill_name, skill_description, config)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [skillId, agentId, skill_key, skill_name, skill_description,
       config ? JSON.stringify(config) : null]
    );

    const skill = await db.getDb().get('SELECT * FROM agent_skills WHERE id = ?', [skillId]);
    res.json(skill);
  });

  router.patch('/agents/skills/:skillId', async (req, res) => {
    const { skillId } = req.params;
    const { enabled, config } = req.body;

    const success = await agentScheduler.updateAgentSkill(skillId, { enabled, config });

    if (!success) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    const skill = await db.getDb().get('SELECT * FROM agent_skills WHERE id = ?', [skillId]);
    res.json(skill);
  });

  router.delete('/agents/skills/:skillId', async (req, res) => {
    await db.getDb().run('DELETE FROM agent_skills WHERE id = ?', [req.params.skillId]);
    res.json({ success: true });
  });

  // ============ Agent 执行历史 ============

  router.get('/agents/:id/executions', async (req, res) => {
    const limit = clampLimit(req.query.limit);
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const history = await agentScheduler.getExecutionHistory(
      req.params.id,
      undefined,
      limit,
      offset
    );
    res.json(history);
  });

  router.get('/projects/:id/executions', async (req, res) => {
    const limit = clampLimit(req.query.limit);
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const history = await agentScheduler.getExecutionHistory(
      undefined,
      req.params.id,
      limit,
      offset
    );
    res.json(history);
  });

  router.get('/executions/:executionId', async (req, res) => {
    const detail = await agentScheduler.getExecutionDetail(req.params.executionId);
    if (!detail.execution) {
      return res.status(404).json({ error: 'Execution not found' });
    }
    res.json(detail);
  });

  // ============ Agent 调度管理 ============

  router.get('/agents/:id/queue', async (req, res) => {
    const status = await agentScheduler.getAgentStatus(req.params.id);
    res.json(status);
  });

  router.post('/agents/:id/cancel', async (req, res) => {
    const { taskId } = req.body;
    const success = await agentScheduler.cancelTask(taskId);
    res.json({ success });
  });

  // ============ Project Context ============
  router.get('/projects/:id/context', async (req, res) => {
    const context = await db.getDb().get(
      'SELECT * FROM project_context WHERE project_id = ?',
      [req.params.id]
    );
    res.json(context || { project_id: req.params.id });
  });

  router.patch('/projects/:id/context', async (req, res) => {
    const { id } = req.params;
    const { requirements, tech_stack, architecture, coding_standards } = req.body;

    await db.getDb().run(`
      INSERT INTO project_context (project_id, requirements, tech_stack, architecture, coding_standards)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        requirements = COALESCE(?, requirements),
        tech_stack = COALESCE(?, tech_stack),
        architecture = COALESCE(?, architecture),
        coding_standards = COALESCE(?, coding_standards),
        updated_at = CURRENT_TIMESTAMP
    `, [id, requirements, tech_stack, architecture, coding_standards,
        requirements, tech_stack, architecture, coding_standards]);

    const context = await db.getDb().get('SELECT * FROM project_context WHERE project_id = ?', [id]);
    res.json(context);
  });

  // ============ Files ============
  router.get('/projects/:id/files', async (req, res) => {
    const files = await db.getDb().all(
      'SELECT id, path, updated_at as updatedAt FROM files WHERE project_id = ? ORDER BY path',
      [req.params.id]
    );
    res.json(files);
  });

  router.get('/projects/:id/files/*', async (req, res) => {
    const filePath = (req.params as any)[0];
    const file = await db.getDb().get(
      'SELECT * FROM files WHERE project_id = ? AND path = ?',
      [req.params.id, filePath]
    );

    if (!file) return res.status(404).json({ error: 'File not found' });
    res.json(file);
  });

  router.post('/projects/:id/files', async (req, res) => {
    const { path: filePath, content } = req.body;

    const err = validateRequired(req.body, ['path']);
    if (err) return res.status(400).json({ error: err });

    await db.getDb().run(
      `INSERT INTO files (id, project_id, path, content) VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id, path) DO UPDATE SET content = ?, updated_at = CURRENT_TIMESTAMP`,
      [`file-${Date.now()}`, req.params.id, filePath, content, content]
    );

    const file = await db.getDb().get(
      'SELECT * FROM files WHERE project_id = ? AND path = ?',
      [req.params.id, filePath]
    );
    res.json(file);
  });

  // ============ Dashboard / Stats ============
  router.get('/stats', async (req, res) => {
    const stats = await db.getDb().get(`
      SELECT
        (SELECT COUNT(*) FROM teams) as team_count,
        (SELECT COUNT(*) FROM projects) as project_count,
        (SELECT COUNT(*) FROM users) as user_count,
        (SELECT COUNT(*) FROM agents) as agent_count,
        (SELECT COUNT(*) FROM messages) as message_count,
        (SELECT COUNT(*) FROM agent_executions) as execution_count,
        (SELECT COUNT(*) FROM agent_executions WHERE status = 'running') as running_executions
    `);
    res.json(stats);
  });

  // ============ Agent 运行时状态（全局） ============
  router.get('/runtime/agents', async (req, res) => {
    const agents = await db.getDb().all(`
      SELECT a.*, t.name as team_name,
        (SELECT COUNT(*) FROM agent_executions WHERE agent_id = a.id) as total_executions,
        (SELECT COUNT(*) FROM agent_executions WHERE agent_id = a.id AND status = 'failed') as failed_executions
      FROM agents a
      LEFT JOIN teams t ON a.team_id = t.id
      ORDER BY a.team_id, a.role
    `);
    res.json(agents);
  });

  return router;
}
