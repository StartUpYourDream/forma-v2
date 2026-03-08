import { create } from "zustand";

interface User {
  id: string;
  name: string;
  email: string;
  avatar: string;
  type: "user";
  status: string;
}

interface Agent {
  id: string;
  name: string;
  role: string;
  avatar: string;
  status: "idle" | "working" | "offline";
  type: "agent";
}

interface Team {
  id: string;
  name: string;
  owner_id: string;
}

interface Project {
  id: string;
  team_id: string;
  name: string;
  description?: string;
}

interface Message {
  id: string;
  project_id: string;
  author_id: string;
  author_type: "user" | "agent" | "system";
  author_name: string;
  author_avatar: string;
  content: string;
  mentions: string[];
  created_at: string;
}

interface StreamingMessage {
  agentId: string;
  content: string;
}

interface Store {
  currentUser: User | null;
  currentTeam: string | null;
  currentProject: string | null;
  teams: Team[];
  projects: Project[];
  members: (User | Agent)[];
  messages: Message[];
  streamingMessages: Map<string, StreamingMessage>;
  ws: WebSocket | null;
  showFileBrowser: boolean;

  setCurrentUser: (user: User) => void;
  setCurrentTeam: (teamId: string) => Promise<void>;
  setCurrentProject: (projectId: string | null) => void;
  setShowFileBrowser: (show: boolean) => void;
  loadTeams: () => Promise<void>;
  loadProjects: (teamId: string) => Promise<Project[]>;
  createProject: (name: string, description?: string) => Promise<void>;
  loadMembers: (teamId: string) => Promise<void>;
  loadMessages: (projectId: string) => Promise<void>;
  sendMessage: (content: string, mentions: string[]) => Promise<void>;
  connectWebSocket: (userId: string) => void;
  addMessage: (message: Message) => void;
  updateMemberStatus: (memberId: string, status: string) => void;
}

// [问题11] WebSocket 重连：指数退避 + 最大重试次数
const WS_MAX_RETRIES = 10;
const WS_BASE_DELAY = 1000;

export const useStore = create<Store>((set, get) => {
  let wsRetryCount = 0;

  return {
    currentUser: null,
    currentTeam: null,
    currentProject: null,
    teams: [],
    projects: [],
    members: [],
    messages: [],
    streamingMessages: new Map(),
    ws: null,
    showFileBrowser: false,

    setCurrentUser: (user) => set({ currentUser: user }),

    setShowFileBrowser: (show) => set({ showFileBrowser: show }),

    // [问题2] 修复 race condition：loadProjects 返回值直接使用
    setCurrentTeam: async (teamId) => {
      const { ws, currentProject } = get();

      if (ws && currentProject) {
        ws.send(
          JSON.stringify({ type: "unsubscribe", projectId: currentProject }),
        );
      }

      set({
        currentTeam: teamId,
        currentProject: null,
        projects: [],
        messages: [],
      });

      if (teamId) {
        const projects = await get().loadProjects(teamId);
        await get().loadMembers(teamId);

        // 直接使用返回值，避免 stale state
        if (projects.length > 0) {
          await get().setCurrentProject(projects[0].id);
        }
      }
    },

    setCurrentProject: async (projectId) => {
      const { ws, currentProject } = get();

      if (ws && currentProject) {
        ws.send(
          JSON.stringify({ type: "unsubscribe", projectId: currentProject }),
        );
      }

      set({ currentProject: projectId });

      if (ws && projectId) {
        ws.send(JSON.stringify({ type: "subscribe", projectId }));
      }

      if (projectId) {
        await get().loadMessages(projectId);
      } else {
        set({ messages: [] });
      }
    },

    loadTeams: async () => {
      const res = await fetch("/api/teams");
      const teams = await res.json();
      set({ teams });

      if (teams.length > 0 && !get().currentTeam) {
        await get().setCurrentTeam(teams[0].id);
      }
    },

    // [问题2] 返回加载的 projects，让调用者可以直接使用
    loadProjects: async (teamId) => {
      const res = await fetch(`/api/teams/${teamId}/projects`);
      const projects = await res.json();
      set({ projects });
      return projects;
    },

    createProject: async (name, description) => {
      const { currentTeam, loadProjects, setCurrentProject } = get();
      if (!currentTeam) return;

      const res = await fetch(`/api/teams/${currentTeam}/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description }),
      });

      const project = await res.json();
      await loadProjects(currentTeam);
      setCurrentProject(project.id);
    },

    loadMembers: async (teamId) => {
      const res = await fetch(`/api/teams/${teamId}/members`);
      const members = await res.json();
      set({ members });
    },

    loadMessages: async (projectId) => {
      const res = await fetch(`/api/projects/${projectId}/messages`);
      const messages = await res.json();
      set({ messages });
    },

    sendMessage: async (content, mentions) => {
      const { currentProject } = get();
      if (!currentProject) return;

      await fetch(`/api/projects/${currentProject}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, mentions }),
      });
    },

    // [问题1] 动态选择 ws/wss 协议
    // [问题11] 指数退避 + 最大重试次数
    connectWebSocket: (userId) => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

      ws.onopen = () => {
        wsRetryCount = 0;
        ws.send(JSON.stringify({ type: "auth", userId }));

        const { currentProject } = get();
        if (currentProject) {
          ws.send(
            JSON.stringify({ type: "subscribe", projectId: currentProject }),
          );
        }
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);

        switch (data.type) {
          case "message":
            get().addMessage(data.message);
            break;
          case "agent_status":
            get().updateMemberStatus(data.agentId, data.status);
            break;
          case "agent_stream_start": {
            const next = new Map(get().streamingMessages);
            next.set(data.agentId, { agentId: data.agentId, content: "" });
            set({ streamingMessages: next });
            break;
          }
          case "agent_stream": {
            const next = new Map(get().streamingMessages);
            const existing = next.get(data.agentId);
            if (existing) {
              next.set(data.agentId, {
                ...existing,
                content: existing.content + data.content,
              });
            }
            set({ streamingMessages: next });
            break;
          }
          case "agent_stream_end": {
            const next = new Map(get().streamingMessages);
            next.delete(data.agentId);
            set({ streamingMessages: next });
            break;
          }
        }
      };

      ws.onclose = () => {
        if (wsRetryCount >= WS_MAX_RETRIES) {
          console.warn("WebSocket 重连次数已达上限，停止重连");
          return;
        }
        const delay = Math.min(
          WS_BASE_DELAY * Math.pow(2, wsRetryCount),
          30000,
        );
        wsRetryCount++;
        setTimeout(() => get().connectWebSocket(userId), delay);
      };

      set({ ws });
    },

    addMessage: (message) => {
      set((state) => ({ messages: [...state.messages, message] }));
    },

    updateMemberStatus: (memberId, status) => {
      set((state) => ({
        members: state.members.map((m) =>
          m.id === memberId ? { ...m, status: status as any } : m,
        ),
      }));
    },
  };
});
