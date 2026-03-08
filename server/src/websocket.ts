import { WebSocketServer, WebSocket } from 'ws';
import type FormaDB from './db.js';
import type { AgentScheduler } from './agents/scheduler.js';

interface WSClient {
  ws: WebSocket;
  userId: string;
  projects: Set<string>;  // 订阅的项目
}

const clients = new Map<string, WSClient>();

export function setupWebSocket(wss: WebSocketServer, db: FormaDB, agentScheduler: AgentScheduler) {
  wss.on('connection', (ws: WebSocket) => {
    const clientId = `ws-${Date.now()}`;
    console.log(`WebSocket connected: ${clientId}`);
    
    const client: WSClient = {
      ws,
      userId: '',
      projects: new Set()
    };
    
    clients.set(clientId, client);

    ws.on('message', async (data: string) => {
      try {
        const message = JSON.parse(data);
        
        switch (message.type) {
          case 'auth':
            client.userId = message.userId;
            break;
            
          case 'subscribe':
            // 订阅项目消息
            client.projects.add(message.projectId);
            break;
            
          case 'unsubscribe':
            client.projects.delete(message.projectId);
            break;
        }
      } catch (err) {
        console.error('WebSocket message error:', err);
      }
    });

    ws.on('close', () => {
      clients.delete(clientId);
      console.log(`WebSocket disconnected: ${clientId}`);
    });
  });
}

// 广播到项目
export function broadcastToProject(projectId: string, data: any, excludeClientId?: string) {
  const message = JSON.stringify(data);
  
  for (const [id, client] of clients) {
    if (id !== excludeClientId && client.projects.has(projectId)) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(message);
      }
    }
  }
}
