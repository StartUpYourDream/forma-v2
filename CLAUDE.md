# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 常用命令

```bash
# 开发（同时启动前后端）
npm run dev

# 单独启动
npm run dev:server   # server: tsx watch, port 3001
npm run dev:client   # client: vite, port 3000

# 构建
npm run build        # 构建前端 (tsc + vite build)
cd server && npm run build  # 构建后端 (tsc)

# 类型检查
cd client && npx tsc --noEmit
cd server && npx tsc --noEmit
```

没有测试框架，没有 linter 配置。

## 架构概览

AI 团队协作平台：用户在项目中通过 @提及 AI Agent 进行协作开发。

```
Client (React + Vite :3000)  ──API proxy──▶  Server (Express :3001)
         │                                        │
    Zustand Store                           SQLite (./data/forma.db)
    WebSocket ◀──────── 实时广播 ──────────── WebSocket (/ws)
                                                  │
                                           AgentScheduler
                                              └── OpenAI API
```

### 数据模型

```
User → Team → Project → Messages + Files
              └── Agents (pm/architect/developer/tester)
                  └── AgentSkills
                  └── AgentExecutions → ExecutionLogs
```

- **Team**: 团队，包含真人和 AI Agent 成员
- **Project**: 项目即聊天单元，Message 直接关联 Project（无 Channel 概念）
- **Agent**: 按角色（pm/architect/developer/tester）分工，支持实例组负载均衡（instance_group）
- **ProjectContext**: 项目级上下文（技术栈、架构、编码规范），Agent 处理任务时自动读取

### 核心流程：Agent 调度

1. 用户发消息 @Agent → POST `/api/projects/:id/messages`
2. 路由层检测 mentions，调用 `agentScheduler.submitTask()`
3. Scheduler 入队（优先级排序），选择空闲 Worker 执行
4. Agent 调用 OpenAI API 生成回复（带工具调用能力）
5. 回复写入 DB，通过 WebSocket 广播到订阅该项目的客户端
6. Agent 回复中若 @其他 Agent，递归提交新任务

### 关键文件

| 文件 | 职责 |
|------|------|
| `server/src/agents/scheduler.ts` | Agent 调度核心：任务队列、执行、重试、工具系统、OpenAI 调用 |
| `server/src/routes/index.ts` | 所有 REST API 端点 |
| `server/src/db.ts` | SQLite schema 定义 + 种子数据 |
| `server/src/websocket.ts` | WebSocket 连接管理 + 项目级广播 |
| `client/src/store/index.ts` | Zustand 全局状态：团队/项目/消息/成员/WS 连接 |
| `client/src/components/Chat.tsx` | 聊天界面 + @提及下拉 |
| `client/src/components/Sidebar.tsx` | 团队-项目树形导航 |

### 前端状态管理

Zustand store 管理所有状态，组件通过 `useStore()` 订阅。关键 async 流程：
- `loadTeams()` → 自动 `setCurrentTeam()` → 加载 projects + members → 自动选中第一个项目
- `setCurrentProject()` → 取消旧 WS 订阅 → 订阅新项目 → 加载消息
- WebSocket 接收 `message` / `agent_status` 事件更新 store

### Vite 开发代理

`/api` → `http://localhost:3001`，`/ws` → `ws://localhost:3001`

## 环境变量

| 变量 | 用途 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | 3001 |
| `DB_PATH` | SQLite 数据库路径 | `./data/forma.db` |
| `OPENAI_API_KEY` | OpenAI API 密钥 | `sk-test`（使用 mock 响应） |
| `OPENAI_BASE_URL` | OpenAI API 地址（兼容 API） | — |
