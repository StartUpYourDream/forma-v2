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

interface AuthResponse {
  success: boolean;
  error?: string;
}

interface Store {
  // 认证状态
  isAuthenticated: boolean;
  accessToken: string | null;
  refreshToken: string | null;

  // 应用状态
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

  // 认证方法
  initAuth: () => Promise<void>;
  login: (email: string, password: string) => Promise<AuthResponse>;
  register: (
    name: string,
    email: string,
    password: string,
  ) => Promise<AuthResponse>;
  logout: () => Promise<void>;
  refreshAccessToken: () => Promise<boolean>;

  // 应用方法
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

const WS_MAX_RETRIES = 10;
const WS_BASE_DELAY = 1000;
const STORAGE_KEY = "forma_auth";

export const useStore = create<Store>((set, get) => {
  let wsRetryCount = 0;

  // 带 Authorization header 的 fetch
  const authFetch = (url: string, options: RequestInit = {}) => {
    const { accessToken } = get();
    const headers = new Headers(options.headers);
    if (accessToken) {
      headers.set("Authorization", `Bearer ${accessToken}`);
    }
    return fetch(url, { ...options, headers });
  };

  const authPost = (url: string, body: unknown) =>
    authFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  // 保存/清除 token 到 localStorage
  const persistTokens = (accessToken: string, refreshToken: string) => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ accessToken, refreshToken }),
    );
  };
  const clearTokens = () => localStorage.removeItem(STORAGE_KEY);

  // 登录成功后的共享流程
  const onAuthSuccess = async (data: {
    user: User;
    accessToken: string;
    refreshToken: string;
  }) => {
    persistTokens(data.accessToken, data.refreshToken);
    set({
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      currentUser: data.user,
      isAuthenticated: true,
    });
    get().connectWebSocket(data.user.id);
    await get().loadTeams();
  };

  return {
    // 认证状态
    isAuthenticated: false,
    accessToken: null,
    refreshToken: null,

    // 应用状态
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

    // === 认证方法 ===

    initAuth: async () => {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) return;

      try {
        const { accessToken, refreshToken } = JSON.parse(stored);
        set({ accessToken, refreshToken });

        const res = await fetch("/api/me", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (res.ok) {
          const user = await res.json();
          set({ currentUser: user, isAuthenticated: true });
          get().connectWebSocket(user.id);
          await get().loadTeams();
        } else if (res.status === 401 && refreshToken) {
          const refreshed = await get().refreshAccessToken();
          if (refreshed) {
            // 重试 with new token
            const retryRes = await authFetch("/api/me");
            if (retryRes.ok) {
              const user = await retryRes.json();
              set({ currentUser: user, isAuthenticated: true });
              get().connectWebSocket(user.id);
              await get().loadTeams();
            }
          }
        }
      } catch {
        clearTokens();
      }
    },

    login: async (email, password) => {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) return { success: false, error: data.error };

      await onAuthSuccess(data);
      return { success: true };
    },

    register: async (name, email, password) => {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });
      const data = await res.json();
      if (!res.ok) return { success: false, error: data.error };

      await onAuthSuccess(data);
      return { success: true };
    },

    logout: async () => {
      const { refreshToken, ws } = get();
      try {
        await fetch("/api/auth/logout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken }),
        });
      } catch {
        // 忽略网络错误，仍然清除本地状态
      }
      if (ws) ws.close();
      clearTokens();
      set({
        isAuthenticated: false,
        accessToken: null,
        refreshToken: null,
        currentUser: null,
        currentTeam: null,
        currentProject: null,
        teams: [],
        projects: [],
        members: [],
        messages: [],
        streamingMessages: new Map(),
        ws: null,
      });
    },

    refreshAccessToken: async () => {
      const { refreshToken } = get();
      if (!refreshToken) return false;

      try {
        const res = await fetch("/api/auth/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken }),
        });
        if (!res.ok) return false;

        const data = await res.json();
        persistTokens(data.accessToken, data.refreshToken);
        set({
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
        });
        return true;
      } catch {
        return false;
      }
    },

    // === 应用方法 ===

    setCurrentUser: (user) => set({ currentUser: user }),
    setShowFileBrowser: (show) => set({ showFileBrowser: show }),

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
      const res = await authFetch("/api/teams");
      const teams = await res.json();
      set({ teams });

      if (teams.length > 0 && !get().currentTeam) {
        await get().setCurrentTeam(teams[0].id);
      }
    },

    loadProjects: async (teamId) => {
      const res = await authFetch(`/api/teams/${teamId}/projects`);
      const projects = await res.json();
      set({ projects });
      return projects;
    },

    createProject: async (name, description) => {
      const { currentTeam, loadProjects, setCurrentProject } = get();
      if (!currentTeam) return;

      const res = await authPost(`/api/teams/${currentTeam}/projects`, {
        name,
        description,
      });
      const project = await res.json();
      await loadProjects(currentTeam);
      setCurrentProject(project.id);
    },

    loadMembers: async (teamId) => {
      const res = await authFetch(`/api/teams/${teamId}/members`);
      const members = await res.json();
      set({ members });
    },

    loadMessages: async (projectId) => {
      const res = await authFetch(`/api/projects/${projectId}/messages`);
      const messages = await res.json();
      set({ messages });
    },

    sendMessage: async (content, mentions) => {
      const { currentProject } = get();
      if (!currentProject) return;

      await authPost(`/api/projects/${currentProject}/messages`, {
        content,
        mentions,
      });
    },

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
            const prev = get().streamingMessages;
            const existing = prev.get(data.agentId);
            if (existing) {
              const next = new Map(prev);
              next.set(data.agentId, {
                agentId: data.agentId,
                content: existing.content + data.content,
              });
              set({ streamingMessages: next });
            }
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
