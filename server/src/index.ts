import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import Database from './db.js';
import { setupRoutes } from './routes/index.js';
import { setupWebSocket } from './websocket.js';
import { AgentScheduler } from './agents/scheduler.js';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Middleware
app.use(cors());
app.use(express.json());

// Initialize database
const db = new Database();
await db.init();

// Initialize agent scheduler (新的调度中心)
const agentScheduler = new AgentScheduler(db);

// Setup routes
app.use('/api', setupRoutes(db, agentScheduler));

// Setup WebSocket
setupWebSocket(wss, db, agentScheduler);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Forma V2 server running on port ${PORT}`);
  console.log(`📊 WebSocket available at ws://localhost:${PORT}/ws`);
  console.log(`🤖 Agent Scheduler initialized`);
});

// [问题21] Graceful shutdown
async function shutdown(signal: string) {
  console.log(`\n${signal} received, shutting down gracefully...`);

  // 关闭 WebSocket 连接
  wss.clients.forEach(client => client.close());
  wss.close();

  // 关闭 HTTP 服务器（停止接受新连接）
  server.close(() => {
    console.log('HTTP server closed');
  });

  // 关闭数据库
  await db.close();
  console.log('Database closed');

  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
