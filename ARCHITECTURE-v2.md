# Forma V2 架构重构方案

## 1. 核心概念重新定义

```
┌─────────────────────────────────────────────────────────────┐
│  用户 User (Votan)                                          │
│  └── 团队列表                                               │
│      └── 团队 Team ("JustDo")                               │
│          ├── 成员 Members                                   │
│          │   ├── 真人: Votan, Johnny...                     │
│          │   └── Agent: PM-AI, 架构师-AI, 开发-AI...        │
│          │                                                  │
│          └── 项目 Projects                                  │
│              ├── 项目 Project ("Forma")                     │
│              │   ├── 聊天 Messages                          │
│              │   └── 代码 Files                             │
│              │                                              │
│              └── 项目 Project ("Tlist")                     │
│                  ├── 聊天 Messages                          │
│                  └── 代码 Files                             │
└─────────────────────────────────────────────────────────────┘
```

**关键变化：**
- ❌ 去掉"频道(Channel)"概念
- ✅ Message 直接关联 Project
- ✅ 每个项目有自己的完整上下文

---

## 2. 数据模型变更

### 当前（有问题）
```typescript
// 频道作为中间层
Channel {
  id, team_id, name, type
}
Message {
  channel_id  // 关联频道
}
Project {
  // 独立存在，不关联聊天
}
```

### 新架构
```typescript
// 项目即聊天单元
Project {
  id
  team_id
  name              // "Forma"
  description       // "AI团队协作平台"
  created_at
}

Message {
  id
  project_id        // 直接关联项目！
  author_id
  author_type
  content
  mentions
  created_at
}

File {
  id
  project_id        // 关联同一项目
  path
  content
}

// 项目上下文（全局记忆）
ProjectContext {
  project_id
  requirements      // 需求文档
  tech_stack        // 技术栈
  architecture      // 架构设计
  coding_standards  // 代码规范
}
```

---

## 3. 界面结构调整

### 当前（Discord式）
```
┌──────────┬───────────────────┬──────────┐
│ 频道列表   │ 聊天区域           │ 成员列表  │
│ #general │                   │          │
│ #开发     │                   │          │
└──────────┴───────────────────┴──────────┘
```

### 新设计（项目为中心）
```
┌──────────┬───────────────────┬──────────┐
│ 团队侧栏   │ 项目聊天区          │ 成员列表  │
│          │                   │          │
│ JustDo   │ ┌───────────────┐ │ Votan    │
│ ──────── │ │ 项目: Forma    │ │ Johnny   │
│ 📁 Forma │ │               │ │ PM-AI    │
│ 📁 Tlist │ │ Votan: xxx    │ │ 开发-AI  │
│          │ │ PM-AI: xxx    │ │          │
│ 🤖 Agent │ │               │ │          │
│ 👥 成员   │ └───────────────┘ │          │
│ ⚙️ 设置   │ [输入框...]        │          │
└──────────┴───────────────────┴──────────┘
```

---

## 4. 修改清单

### 后端修改

#### 数据库 Schema
```sql
-- 删除 channels 表
DROP TABLE IF EXISTS channels;
DROP TABLE IF EXISTS channel_members;

-- 修改 messages 表
ALTER TABLE messages 
  DROP COLUMN channel_id,
  ADD COLUMN project_id TEXT;

-- 添加 project_members（项目成员访问权限）
CREATE TABLE project_members (
  project_id TEXT,
  member_id TEXT,
  member_type TEXT,
  role TEXT,  -- owner, member
  PRIMARY KEY (project_id, member_id)
);
```

#### API 路由变更
| 旧接口 | 新接口 | 说明 |
|--------|--------|------|
| GET /api/teams/:id/channels | GET /api/teams/:id/projects | 获取团队项目列表 |
| GET /api/channels/:id/messages | GET /api/projects/:id/messages | 获取项目聊天 |
| POST /api/channels/:id/messages | POST /api/projects/:id/messages | 发送消息 |
| (删除) | POST /api/projects/:id/members | 添加成员到项目 |

### 前端修改

#### 组件重构
```
Sidebar.tsx
├── TeamSelector      # 切换团队
├── ProjectList       # 项目列表（原频道列表）
├── AgentList         # Agent列表
└── MemberList        # 团队成员

Chat.tsx
├── ProjectHeader     # 项目标题
├── MessageList       # 消息列表
├── MessageInput      # 输入框
└── FileBrowserButton # 文件浏览器入口

FileBrowser.tsx       # 保持不变
```

#### Store 调整
```typescript
interface Store {
  currentTeam: Team
  currentProject: Project    // 替换 currentChannel
  projects: Project[]        // 替换 channels
  messages: Message[]        // 当前项目的消息
  
  // 方法变更
  setCurrentProject(id)     // 替换 setCurrentChannel
  loadProjects(teamId)      // 替换 loadChannels
  loadMessages(projectId)   // 参数改为 projectId
  sendMessage(projectId)    // 参数改为 projectId
}
```

---

## 5. 关键交互流程

### 创建新项目
```
1. 点击"新建项目"
2. 输入项目名称: "Tlist"
3. 系统创建 Project 记录
4. 自动跳转到项目聊天页
5. 可以@Agent开始协作
```

### 切换项目
```
1. 点击侧栏项目"Forma"
2. 加载该项目的消息历史
3. 加载该项目的文件列表
4. 成员列表显示有权限的成员
```

### Agent协作
```
用户在"Forma"项目发消息:
"@PM-AI 设计登录功能"

PM-AI响应:
"好的，需求如下：...
@架构师-AI 帮忙看看技术方案？"

架构师-AI收到@，自动回复...
```

---

## 6. 权限模型

```typescript
// 团队级别权限
team_members {
  role: 'owner' | 'admin' | 'member'
}

// 项目级别权限（可选更细粒度）
project_members {
  role: 'owner' | 'contributor' | 'viewer'
}

// 简化方案：所有团队成员可访问所有项目
// 后续再添加项目级权限
```

---

## 7. 实施步骤

### Step 1: 后端数据库迁移
1. 备份数据
2. 删除 channels/channel_members 表
3. 修改 messages 表（channel_id → project_id）
4. 添加 project_members 表
5. 更新路由

### Step 2: 前端组件重构
1. 更新 Sidebar（项目列表替代频道）
2. 更新 Chat（project_id 替代 channel_id）
3. 更新 Store
4. 更新类型定义

### Step 3: 数据迁移脚本
1. 将现有 channel-1 的消息迁移到 project
2. 确保项目有正确的 member 关联

### Step 4: 测试验证
1. 创建团队
2. 创建项目
3. 发送消息
4. 验证Agent回复
5. 验证文件操作

---

## 8. 命名规范

| 层级 | 命名示例 |
|------|----------|
| 产品 | Forma V2 |
| 团队 | JustDo, AcmeCorp |
| 项目 | Forma, Tlist, LandingPage |
| Agent | PM-AI, Arch-AI, Dev-AI |

---

*方案制定: 2026-03-06*
*待评审后开始实施*
