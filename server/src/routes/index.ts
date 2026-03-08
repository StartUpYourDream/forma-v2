import { Router } from 'express';
import type FormaDB from '../db.js';
import type { AgentScheduler } from '../agents/scheduler.js';
import {
  hashPassword,
  verifyPassword,
  generateTokenPair,
  saveRefreshToken,
  validateRefreshToken,
  revokeRefreshToken,
  revokeAllUserRefreshTokens,
  createAuthMiddleware,
  type UserInfo
} from '../auth.js';

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

// 邮箱格式验证
function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// 密码强度验证
function validatePassword(password: string): string | null {
  if (password.length < 8) {
    return '密码长度至少为8位';
  }
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return '密码必须包含字母和数字';
  }
  return null;
}

export function setupRoutes(db: FormaDB, agentScheduler: AgentScheduler) {
  const router = Router();
  const authMiddleware = createAuthMiddleware(db);

  // ============ Auth ============
  // 注册
  router.post('/auth/register', async (req, res) => {
    const { name, email, password } = req.body;

    // 输入验证
    const err = validateRequired(req.body, ['name', 'email', 'password']);
    if (err) return res.status(400).json({ error: err });

    const lenErr = validateStringLength(name, 'name', 50);
    if (lenErr) return res.status(400).json({ error: lenErr });

    if (!validateEmail(email)) {
      return res.status(400).json({ error: '邮箱格式不正确' });
    }

    const pwdErr = validatePassword(password);
    if (pwdErr) return res.status(400).json({ error: pwdErr });

    // 检查邮箱是否已存在
    const existingUser = await db.getDb().get('SELECT id FROM users WHERE email = ?', [email]);
    if (existingUser) {
      return res.status(409).json({ error: '该邮箱已被注册' });
    }

    // 创建用户
    const userId = `user-${Date.now()}`;
    const passwordHash = await hashPassword(password);

    await db.getDb().run(
      'INSERT INTO users (id, name, email, password, avatar) VALUES (?, ?, ?, ?, ?)',
      [userId, name, email, passwordHash, `https://api.dicebear.com/7.x/avataaars/svg?seed=${userId}`]
    );

    // 生成令牌
    const { accessToken, refreshToken } = generateTokenPair(userId, email);

    // 保存刷新令牌
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);
    await saveRefreshToken(db, userId, refreshToken, expiresAt);

    // 返回用户信息和令牌
    const user = await db.getDb().get<UserInfo>(
      'SELECT id, name, email, avatar FROM users WHERE id = ?',
      [userId]
    );

    res.status(201).json({
      user,
      accessToken,
      refreshToken
    });
  });

  // 登录
  router.post('/auth/login', async (req, res) => {
    const { email, password } = req.body;

    // 输入验证
    const err = validateRequired(req.body, ['email', 'password']);
    if (err) return res.status(400).json({ error: err });

    // 查找用户
    const user = await db.getDb().get<{ id: string; name: string; email: string; avatar: string; password: string }>(
      'SELECT id, name, email, avatar, password FROM users WHERE email = ?',
      [email]
    );

    if (!user || !user.password) {
      return res.status(401).json({ error: '邮箱或密码不正确' });
    }

    // 验证密码
    const isValid = await verifyPassword(password, user.password);
    if (!isValid) {
      return res.status(401).json({ error: '邮箱或密码不正确' });
    }

    // 生成令牌
    const { accessToken, refreshToken } = generateTokenPair(user.id, user.email);

    // 保存刷新令牌
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);
    await saveRefreshToken(db, user.id, refreshToken, expiresAt);

    // 返回用户信息和令牌
    const { password: _, ...userInfo } = user;
    res.json({
      user: userInfo,
      accessToken,
      refreshToken
    });
  });

  // 刷新令牌
  router.post('/auth/refresh', async (req, res) => {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ error: '缺少刷新令牌' });
    }

    // 验证刷新令牌
    const tokenData = await validateRefreshToken(db, refreshToken);
    if (!tokenData) {
      return res.status(401).json({ error: '无效的刷新令牌' });
    }

    // 撤销旧的刷新令牌
    await revokeRefreshToken(db, refreshToken);

    // 生成新令牌对
    const { accessToken, refreshToken: newRefreshToken } = generateTokenPair(
      tokenData.userId,
      tokenData.email
    );

    // 保存新的刷新令牌
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);
    await saveRefreshToken(db, tokenData.userId, newRefreshToken, expiresAt);

    res.json({
      accessToken,
      refreshToken: newRefreshToken
    });
  });

  // 登出
  router.post('/auth/logout', async (req, res) => {
    const { refreshToken } = req.body;

    if (refreshToken) {
      await revokeRefreshToken(db, refreshToken);
    }

    res.json({ success: true });
  });

  // 登出所有设备
  router.post('/auth/logout-all', authMiddleware, async (req, res) => {
    const user = (req as any).user as UserInfo;
    await revokeAllUserRefreshTokens(db, user.id);
    res.json({ success: true });
  });

  // 获取当前用户信息（受保护）
  router.get('/me', authMiddleware, async (req, res) => {
    res.json((req as any).user);
  });

  // 修改密码
  router.post('/auth/change-password', authMiddleware, async (req, res) => {
    const user = (req as any).user as UserInfo;
    const { currentPassword, newPassword } = req.body;

    const err = validateRequired(req.body, ['currentPassword', 'newPassword']);
    if (err) return res.status(400).json({ error: err });

    const pwdErr = validatePassword(newPassword);
    if (pwdErr) return res.status(400).json({ error: pwdErr });

    // 获取当前密码哈希
    const userData = await db.getDb().get<{ password: string }>(
      'SELECT password FROM users WHERE id = ?',
      [user.id]
    );

    if (!userData || !userData.password) {
      return res.status(400).json({ error: '无法修改密码' });
    }

    // 验证当前密码
    const isValid = await verifyPassword(currentPassword, userData.password);
    if (!isValid) {
      return res.status(401).json({ error: '当前密码不正确' });
    }

    // 更新密码
    const newHash = await hashPassword(newPassword);
    await db.getDb().run(
      'UPDATE users SET password = ? WHERE id = ?',
      [newHash, user.id]
    );

    // 撤销所有刷新令牌（强制重新登录）
    await revokeAllUserRefreshTokens(db, user.id);

    res.json({ success: true });
  });

  // ============ Teams ============
  router.get('/teams', authMiddleware, async (req, res) => {
    const user = (req as any).user as UserInfo;
    // 只返回用户有权限访问的团队
    const teams = await db.getDb().all(`
      SELECT t.* FROM teams t
      JOIN team_members tm ON t.id = tm.team_id
      WHERE tm.member_id = ? AND tm.member_type = 'user'
    `, [user.id]);
    res.json(teams);
  });

  router.get('/teams/:id', authMiddleware, async (req, res) => {
    const user = (req as any).user as UserInfo;
    const team = await db.getDb().get(`
      SELECT t.* FROM teams t
      JOIN team_members tm ON t.id = tm.team_id
      WHERE t.id = ? AND tm.member_id = ?
    `, [req.params.id, user.id]);
    
    if (!team) {
      return res.status(404).json({ error: '团队不存在或无访问权限' });
    }
    res.json(team);
  });

  router.post('/teams', authMiddleware, async (req, res) => {
    const user = (req as any).user as UserInfo;
    const { name } = req.body;

    // [问题14] 输入验证
    const err = validateRequired(req.body, ['name']);
    if (err) return res.status(400).json({ error: err });
    const lenErr = validateStringLength(name, 'name', 100);
    if (lenErr) return res.status(400).json({ error: lenErr });

    const teamId = `team-${Date.now()}`;

    await db.getDb().run(
      'INSERT INTO teams (id, name, owner_id) VALUES (?, ?, ?)',
      [teamId, name, user.id]
    );

    await db.getDb().run(
      'INSERT INTO team_members (team_id, member_id, member_type, role) VALUES (?, ?, ?, ?)',
      [teamId, user.id, 'user', 'owner']
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
  router.get('/teams/:id/members', authMiddleware, async (req, res) => {
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
  router.get('/teams/:id/projects', authMiddleware, async (req, res) => {
    const user = (req as any).user as UserInfo;
    // 检查用户是否有权访问该团队
    const member = await db.getDb().get(
      'SELECT 1 FROM team_members WHERE team_id = ? AND member_id = ?',
      [req.params.id, user.id]
    );
    if (!member) {
      return res.status(403).json({ error: '无权访问该团队的项目' });
    }

    const projects = await db.getDb().all(
      'SELECT * FROM projects WHERE team_id = ? ORDER BY created_at',
      [req.params.id]
    );
    res.json(projects);
  });

  router.post('/teams/:id/projects', authMiddleware, async (req, res) => {
    const user = (req as any).user as UserInfo;
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

  router.get('/projects/:id', authMiddleware, async (req, res) => {
    const user = (req as any).user as UserInfo;
    const project = await db.getDb().get(`
      SELECT p.* FROM projects p
      JOIN team_members tm ON p.team_id = tm.team_id
      WHERE p.id = ? AND tm.member_id = ?
    `, [req.params.id, user.id]);
    
    if (!project) {
      return res.status(404).json({ error: '项目不存在或无权访问' });
    }
    res.json(project);
  });

  // ============ Messages ============
  router.get('/projects/:id/messages', authMiddleware, async (req, res) => {
    const user = (req as any).user as UserInfo;
    const { id } = req.params;
    
    // 检查用户是否有权访问该项目
    const project = await db.getDb().get(`
      SELECT p.id FROM projects p
      JOIN team_members tm ON p.team_id = tm.team_id
      WHERE p.id = ? AND tm.member_id = ?
    `, [id, user.id]);
    
    if (!project) {
      return res.status(403).json({ error: '无权访问该项目的消息' });
    }
    
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

  router.post('/projects/:id/messages', authMiddleware, async (req, res) => {
    const user = (req as any).user as UserInfo;
    const { id } = req.params;
    const { content, mentions = [] } = req.body;

    // 检查用户是否有权访问该项目
    const project = await db.getDb().get(`
      SELECT p.id FROM projects p
      JOIN team_members tm ON p.team_id = tm.team_id
      WHERE p.id = ? AND tm.member_id = ?
    `, [id, user.id]);
    
    if (!project) {
      return res.status(403).json({ error: '无权在该项目发送消息' });
    }

    const err = validateRequired(req.body, ['content']);
    if (err) return res.status(400).json({ error: err });
    const lenErr = validateStringLength(content, 'content', 10000);
    if (lenErr) return res.status(400).json({ error: lenErr });

    const messageId = `msg-${Date.now()}`;

    await db.getDb().run(
      'INSERT INTO messages (id, project_id, author_id, author_type, content, mentions) VALUES (?, ?, ?, ?, ?, ?)',
      [messageId, id, user.id, 'user', content, JSON.stringify(mentions)]
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

  router.get('/teams/:id/agents', authMiddleware, async (req, res) => {
    const user = (req as any).user as UserInfo;
    // 检查用户是否有权访问该团队
    const member = await db.getDb().get(
      'SELECT 1 FROM team_members WHERE team_id = ? AND member_id = ?',
      [req.params.id, user.id]
    );
    if (!member) {
      return res.status(403).json({ error: '无权访问该团队的Agent' });
    }

    const agents = await db.getDb().all(
      'SELECT * FROM agents WHERE team_id = ? ORDER BY role, name',
      [req.params.id]
    );
    res.json(agents);
  });

  router.get('/agents/:id', authMiddleware, async (req, res) => {
    const user = (req as any).user as UserInfo;
    const agent = await db.getDb().get(`
      SELECT a.* FROM agents a
      JOIN team_members tm ON a.team_id = tm.team_id
      WHERE a.id = ? AND tm.member_id = ?
    `, [req.params.id, user.id]);
    
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const status = await agentScheduler.getAgentStatus(req.params.id);

    res.json({ ...agent, ...status });
  });

  router.post('/teams/:id/agents', authMiddleware, async (req, res) => {
    const user = (req as any).user as UserInfo;
    const { id: teamId } = req.params;
    
    // 检查用户是否有权在该团队创建Agent
    const member = await db.getDb().get(
      'SELECT role FROM team_members WHERE team_id = ? AND member_id = ? AND member_type = \'user\'',
      [teamId, user.id]
    );
    if (!member || (member.role !== 'owner' && member.role !== 'admin')) {
      return res.status(403).json({ error: '只有团队所有者或管理员可以创建Agent' });
    }

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

  router.patch('/agents/:id', authMiddleware, async (req, res) => {
    const user = (req as any).user as UserInfo;
    const { id } = req.params;
    
    // 检查用户是否有权修改该Agent
    const agent = await db.getDb().get(`
      SELECT a.* FROM agents a
      JOIN team_members tm ON a.team_id = tm.team_id
      WHERE a.id = ? AND tm.member_id = ? AND tm.member_type = 'user'
    `, [id, user.id]);
    
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

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

    const updatedAgent = await db.getDb().get('SELECT * FROM agents WHERE id = ?', [id]);
    res.json(updatedAgent);
  });

  // [问题10] 删除 Agent 时级联清理 agent_executions 和 agent_execution_logs
  router.delete('/agents/:id', authMiddleware, async (req, res) => {
    const user = (req as any).user as UserInfo;
    const { id } = req.params;
    
    // 检查用户是否有权删除该Agent
    const agent = await db.getDb().get(`
      SELECT a.* FROM agents a
      JOIN team_members tm ON a.team_id = tm.team_id
      WHERE a.id = ? AND tm.member_id = ? AND tm.member_type = 'user'
    `, [id, user.id]);
    
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

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

  router.get('/instance-groups/:groupId/status', authMiddleware, async (req, res) => {
    const user = (req as any).user as UserInfo;
    // 验证用户是否有权访问该实例组
    const group = await db.getDb().get(`
      SELECT a.instance_group FROM agents a
      JOIN team_members tm ON a.team_id = tm.team_id
      WHERE a.instance_group = ? AND tm.member_id = ?
    `, [req.params.groupId, user.id]);
    
    if (!group) {
      return res.status(403).json({ error: '无权访问该实例组' });
    }
    
    const status = await agentScheduler.getInstanceGroupStatus(req.params.groupId);
    res.json(status);
  });

  // ============ Agent 技能管理 ============

  router.get('/agents/:id/skills', authMiddleware, async (req, res) => {
    const user = (req as any).user as UserInfo;
    // 验证用户是否有权访问该Agent
    const agent = await db.getDb().get(`
      SELECT a.id FROM agents a
      JOIN team_members tm ON a.team_id = tm.team_id
      WHERE a.id = ? AND tm.member_id = ?
    `, [req.params.id, user.id]);
    
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    
    const skills = await agentScheduler.getAgentSkills(req.params.id);
    res.json(skills);
  });

  router.post('/agents/:id/skills', authMiddleware, async (req, res) => {
    const user = (req as any).user as UserInfo;
    const { id: agentId } = req.params;
    
    // 验证用户是否有权管理该Agent
    const agent = await db.getDb().get(`
      SELECT a.* FROM agents a
      JOIN team_members tm ON a.team_id = tm.team_id
      WHERE a.id = ? AND tm.member_id = ? AND tm.member_type = 'user'
    `, [agentId, user.id]);
    
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

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

  router.patch('/agents/skills/:skillId', authMiddleware, async (req, res) => {
    const user = (req as any).user as UserInfo;
    const { skillId } = req.params;
    
    // 验证用户是否有权修改该技能
    const skill = await db.getDb().get(`
      SELECT s.* FROM agent_skills s
      JOIN agents a ON s.agent_id = a.id
      JOIN team_members tm ON a.team_id = tm.team_id
      WHERE s.id = ? AND tm.member_id = ? AND tm.member_type = 'user'
    `, [skillId, user.id]);
    
    if (!skill) {
      return res.status(404).json({ error: 'Skill not found' });
    }
    
    const { enabled, config } = req.body;

    const success = await agentScheduler.updateAgentSkill(skillId, { enabled, config });

    if (!success) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    const updatedSkill = await db.getDb().get('SELECT * FROM agent_skills WHERE id = ?', [skillId]);
    res.json(updatedSkill);
  });

  router.delete('/agents/skills/:skillId', authMiddleware, async (req, res) => {
    const user = (req as any).user as UserInfo;
    const { skillId } = req.params;
    
    // 验证用户是否有权删除该技能
    const skill = await db.getDb().get(`
      SELECT s.* FROM agent_skills s
      JOIN agents a ON s.agent_id = a.id
      JOIN team_members tm ON a.team_id = tm.team_id
      WHERE s.id = ? AND tm.member_id = ? AND tm.member_type = 'user'
    `, [skillId, user.id]);
    
    if (!skill) {
      return res.status(404).json({ error: 'Skill not found' });
    }
    
    await db.getDb().run('DELETE FROM agent_skills WHERE id = ?', [skillId]);
    res.json({ success: true });
  });

  // ============ Agent 执行历史 ============

  router.get('/agents/:id/executions', authMiddleware, async (req, res) => {
    const user = (req as any).user as UserInfo;
    // 验证用户是否有权访问该Agent
    const agent = await db.getDb().get(`
      SELECT a.id FROM agents a
      JOIN team_members tm ON a.team_id = tm.team_id
      WHERE a.id = ? AND tm.member_id = ?
    `, [req.params.id, user.id]);
    
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    
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

  router.get('/projects/:id/executions', authMiddleware, async (req, res) => {
    const user = (req as any).user as UserInfo;
    // 验证用户是否有权访问该项目
    const project = await db.getDb().get(`
      SELECT p.id FROM projects p
      JOIN team_members tm ON p.team_id = tm.team_id
      WHERE p.id = ? AND tm.member_id = ?
    `, [req.params.id, user.id]);
    
    if (!project) {
      return res.status(403).json({ error: '无权访问该项目的执行历史' });
    }
    
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

  router.get('/executions/:executionId', authMiddleware, async (req, res) => {
    const user = (req as any).user as UserInfo;
    // 验证用户是否有权访问该执行记录
    const execution = await db.getDb().get(`
      SELECT e.id FROM agent_executions e
      JOIN agents a ON e.agent_id = a.id
      JOIN team_members tm ON a.team_id = tm.team_id
      WHERE e.id = ? AND tm.member_id = ?
    `, [req.params.executionId, user.id]);
    
    if (!execution) {
      return res.status(404).json({ error: 'Execution not found' });
    }
    
    const detail = await agentScheduler.getExecutionDetail(req.params.executionId);
    res.json(detail);
  });

  // ============ Agent 调度管理 ============

  router.get('/agents/:id/queue', authMiddleware, async (req, res) => {
    const user = (req as any).user as UserInfo;
    // 验证用户是否有权访问该Agent
    const agent = await db.getDb().get(`
      SELECT a.id FROM agents a
      JOIN team_members tm ON a.team_id = tm.team_id
      WHERE a.id = ? AND tm.member_id = ?
    `, [req.params.id, user.id]);
    
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    
    const status = await agentScheduler.getAgentStatus(req.params.id);
    res.json(status);
  });

  router.post('/agents/:id/cancel', authMiddleware, async (req, res) => {
    const user = (req as any).user as UserInfo;
    const { taskId } = req.body;
    
    // 验证用户是否有权取消该任务
    const task = await db.getDb().get(`
      SELECT e.id FROM agent_executions e
      JOIN agents a ON e.agent_id = a.id
      JOIN team_members tm ON a.team_id = tm.team_id
      WHERE e.id = ? AND tm.member_id = ?
    `, [taskId, user.id]);
    
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }
    
    const success = await agentScheduler.cancelTask(taskId);
    res.json({ success });
  });

  // ============ Project Context ============
  router.get('/projects/:id/context', authMiddleware, async (req, res) => {
    const user = (req as any).user as UserInfo;
    // 验证用户是否有权访问该项目
    const project = await db.getDb().get(`
      SELECT p.id FROM projects p
      JOIN team_members tm ON p.team_id = tm.team_id
      WHERE p.id = ? AND tm.member_id = ?
    `, [req.params.id, user.id]);
    
    if (!project) {
      return res.status(403).json({ error: '无权访问该项目上下文' });
    }
    
    const context = await db.getDb().get(
      'SELECT * FROM project_context WHERE project_id = ?',
      [req.params.id]
    );
    res.json(context || { project_id: req.params.id });
  });

  router.patch('/projects/:id/context', authMiddleware, async (req, res) => {
    const user = (req as any).user as UserInfo;
    const { id } = req.params;
    
    // 验证用户是否有权修改该项目
    const project = await db.getDb().get(`
      SELECT p.id FROM projects p
      JOIN team_members tm ON p.team_id = tm.team_id
      WHERE p.id = ? AND tm.member_id = ?
    `, [id, user.id]);
    
    if (!project) {
      return res.status(403).json({ error: '无权修改该项目上下文' });
    }
    
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
  router.get('/projects/:id/files', authMiddleware, async (req, res) => {
    const user = (req as any).user as UserInfo;
    // 验证用户是否有权访问该项目
    const project = await db.getDb().get(`
      SELECT p.id FROM projects p
      JOIN team_members tm ON p.team_id = tm.team_id
      WHERE p.id = ? AND tm.member_id = ?
    `, [req.params.id, user.id]);
    
    if (!project) {
      return res.status(403).json({ error: '无权访问该项目的文件' });
    }
    
    const files = await db.getDb().all(
      'SELECT id, path, updated_at as updatedAt FROM files WHERE project_id = ? ORDER BY path',
      [req.params.id]
    );
    res.json(files);
  });

  router.get('/projects/:id/files/*', authMiddleware, async (req, res) => {
    const user = (req as any).user as UserInfo;
    const filePath = (req.params as any)[0];
    
    // 验证用户是否有权访问该项目
    const project = await db.getDb().get(`
      SELECT p.id FROM projects p
      JOIN team_members tm ON p.team_id = tm.team_id
      WHERE p.id = ? AND tm.member_id = ?
    `, [req.params.id, user.id]);
    
    if (!project) {
      return res.status(403).json({ error: '无权访问该项目的文件' });
    }
    
    const file = await db.getDb().get(
      'SELECT * FROM files WHERE project_id = ? AND path = ?',
      [req.params.id, filePath]
    );

    if (!file) return res.status(404).json({ error: 'File not found' });
    res.json(file);
  });

  router.post('/projects/:id/files', authMiddleware, async (req, res) => {
    const user = (req as any).user as UserInfo;
    const { path: filePath, content } = req.body;

    // 验证用户是否有权修改该项目
    const project = await db.getDb().get(`
      SELECT p.id FROM projects p
      JOIN team_members tm ON p.team_id = tm.team_id
      WHERE p.id = ? AND tm.member_id = ?
    `, [req.params.id, user.id]);
    
    if (!project) {
      return res.status(403).json({ error: '无权在该项目中创建或修改文件' });
    }

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
  router.get('/stats', authMiddleware, async (req, res) => {
    const user = (req as any).user as UserInfo;
    // 只统计用户有权限访问的数据
    const stats = await db.getDb().get(`
      SELECT
        (SELECT COUNT(DISTINCT t.id) FROM teams t JOIN team_members tm ON t.id = tm.team_id WHERE tm.member_id = ?) as team_count,
        (SELECT COUNT(DISTINCT p.id) FROM projects p JOIN team_members tm ON p.team_id = tm.team_id WHERE tm.member_id = ?) as project_count,
        (SELECT COUNT(*) FROM users) as user_count,
        (SELECT COUNT(DISTINCT a.id) FROM agents a JOIN team_members tm ON a.team_id = tm.team_id WHERE tm.member_id = ?) as agent_count,
        (SELECT COUNT(*) FROM messages m JOIN projects p ON m.project_id = p.id JOIN team_members tm ON p.team_id = tm.team_id WHERE tm.member_id = ?) as message_count,
        (SELECT COUNT(*) FROM agent_executions e JOIN agents a ON e.agent_id = a.id JOIN team_members tm ON a.team_id = tm.team_id WHERE tm.member_id = ?) as execution_count,
        (SELECT COUNT(*) FROM agent_executions e JOIN agents a ON e.agent_id = a.id JOIN team_members tm ON a.team_id = tm.team_id WHERE tm.member_id = ? AND e.status = 'running') as running_executions
    `, [user.id, user.id, user.id, user.id, user.id, user.id]);
    res.json(stats);
  });

  // ============ Agent 运行时状态（全局） ============
  router.get('/runtime/agents', authMiddleware, async (req, res) => {
    const user = (req as any).user as UserInfo;
    const agents = await db.getDb().all(`
      SELECT a.*, t.name as team_name,
        (SELECT COUNT(*) FROM agent_executions WHERE agent_id = a.id) as total_executions,
        (SELECT COUNT(*) FROM agent_executions WHERE agent_id = a.id AND status = 'failed') as failed_executions
      FROM agents a
      LEFT JOIN teams t ON a.team_id = t.id
      JOIN team_members tm ON a.team_id = tm.team_id
      WHERE tm.member_id = ?
      ORDER BY a.team_id, a.role
    `, [user.id]);
    res.json(agents);
  });

  return router;
}
