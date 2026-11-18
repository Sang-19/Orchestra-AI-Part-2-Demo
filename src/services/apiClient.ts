import { SseStreamParser } from '../utils/sseParser';
import type {
  CollectionRecord,
  CustomToolRecord,
  CustomToolType,
  DashboardStats,
  DocumentRecord,
  ExecutionEvent,
  ResearchMode,
  ResearchPlan,
  ResearchSession,
  RetrievalMatch,
  SessionMessage,
  ToolStatus,
  ToolTestResult,
  User,
  UserSettings,
} from '../types/research';

const TOKEN_STORAGE_KEY = 'orchestra_auth_token';

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token: string | null): void {
  try {
    if (token) {
      localStorage.setItem(TOKEN_STORAGE_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    // Ignore storage quota errors
  }
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getStoredToken();
  const headers = new Headers(init.headers);
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (!(init.body instanceof FormData) && !headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(`/api${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });

  const text = await res.text();
  const data = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T & { error?: string });

  if (!res.ok) {
    throw new Error(data.error || `Request failed with status ${res.status}`);
  }
  return data;
}

export const apiClient = {
  // Auth
  async register(payload: { name: string; email: string; password: string }) {
    const res = await apiFetch<{ user: User; token: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    setStoredToken(res.token);
    return res;
  },

  async login(payload: { email: string; password: string }) {
    const res = await apiFetch<{ user: User; token: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    setStoredToken(res.token);
    return res;
  },

  async logout() {
    await apiFetch('/auth/logout', { method: 'POST' });
    setStoredToken(null);
  },

  checkSession() {
    return apiFetch<{ user: User | null }>('/auth/session');
  },

  me() {
    return apiFetch<{ user: User }>('/auth/me');
  },

  updateProfile(name: string) {
    return apiFetch<{ user: User }>('/auth/profile', {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
  },

  changePassword(currentPassword: string, newPassword: string) {
    return apiFetch<{ ok: boolean }>('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  },

  // Dashboard & Tools
  getDashboardStats() {
    return apiFetch<{ stats: DashboardStats }>('/dashboard/stats');
  },

  getToolsStatus() {
    return apiFetch<{ tools: ToolStatus[]; customTools: CustomToolRecord[] }>('/tools/status');
  },

  getCustomTools() {
    return apiFetch<{ customTools: CustomToolRecord[] }>('/tools/custom');
  },

  createCustomTool(payload: {
    name: string;
    toolType: CustomToolType;
    category: string;
    endpointUrl: string;
    httpMethod: 'GET' | 'POST';
    modelName?: string;
    authEnvVar?: string;
    description: string;
    capabilities: string[];
    enabled?: boolean;
  }) {
    return apiFetch<{ tool: CustomToolRecord }>('/tools/custom', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  updateCustomTool(
    id: string,
    payload: Partial<{
      name: string;
      toolType: CustomToolType;
      category: string;
      endpointUrl: string;
      httpMethod: 'GET' | 'POST';
      modelName: string;
      authEnvVar: string;
      description: string;
      capabilities: string[];
      enabled: boolean;
    }>
  ) {
    return apiFetch<{ tool: CustomToolRecord }>(`/tools/custom/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  },

  deleteCustomTool(id: string) {
    return apiFetch<{ ok: boolean }>(`/tools/custom/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  testCustomTool(id: string) {
    return apiFetch<{ tool: CustomToolRecord; result: ToolTestResult }>(
      `/tools/custom/${encodeURIComponent(id)}/test`,
      {
        method: 'POST',
      }
    );
  },

  // Settings & Data
  getSettings() {
    return apiFetch<{ settings: UserSettings }>('/settings');
  },

  updateSettings(settings: Partial<UserSettings>) {
    return apiFetch<{ settings: UserSettings }>('/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    });
  },

  exportAllData() {
    return apiFetch<Record<string, unknown>>('/data/export');
  },

  clearCompletedHistory() {
    return apiFetch<{ deletedCount: number }>('/data/history', { method: 'DELETE' });
  },

  // Collections & Documents
  getCollections() {
    return apiFetch<{ collections: CollectionRecord[] }>('/collections');
  },

  createCollection(name: string, description: string) {
    return apiFetch<{ collection: CollectionRecord }>('/collections', {
      method: 'POST',
      body: JSON.stringify({ name, description }),
    });
  },

  deleteCollection(id: string) {
    return apiFetch<{ ok: boolean }>(`/collections/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  getDocuments() {
    return apiFetch<{ documents: DocumentRecord[] }>('/documents');
  },

  uploadDocument(file: File, collectionId: string | null) {
    const form = new FormData();
    form.append('file', file);
    if (collectionId) form.append('collectionId', collectionId);
    return apiFetch<{ document: DocumentRecord }>('/documents/upload', {
      method: 'POST',
      body: form,
    });
  },

  ingestTextDocument(payload: { title: string; content: string; collectionId: string | null }) {
    return apiFetch<{ document: DocumentRecord }>('/documents/text', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  deleteDocument(id: string) {
    return apiFetch<{ ok: boolean }>(`/documents/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  semanticSearch(payload: { query: string; collectionIds?: string[]; topK?: number }) {
    return apiFetch<{ matches: RetrievalMatch[] }>('/rag/search', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  // Research & Workflow
  getResearchSessions() {
    return apiFetch<{ sessions: ResearchSession[] }>('/research');
  },

  createResearchSession(payload: {
    question: string;
    mode: ResearchMode;
    includeWeb: boolean;
    includeRag: boolean;
    collectionIds: string[];
    maxRetries: number;
  }) {
    return apiFetch<{ session: ResearchSession }>('/research', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  getResearchSession(id: string) {
    return apiFetch<{ session: ResearchSession; events: ExecutionEvent[] }>(
      `/research/${encodeURIComponent(id)}`
    );
  },

  deleteResearchSession(id: string) {
    return apiFetch<{ ok: boolean }>(`/research/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  approvePlan(id: string, plan?: ResearchPlan) {
    return apiFetch<{ session: ResearchSession }>(`/research/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      body: JSON.stringify({ plan }),
    });
  },

  rejectPlan(id: string, reason?: string, revise?: boolean) {
    return apiFetch<{ session: ResearchSession }>(`/research/${encodeURIComponent(id)}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason, revise: Boolean(revise) }),
    });
  },

  pauseResearch(id: string) {
    return apiFetch<{ session: ResearchSession; requested: boolean }>(`/research/${encodeURIComponent(id)}/pause`, { method: 'POST' });
  },

  stopResearch(id: string) {
    return apiFetch<{ session: ResearchSession; requested: boolean }>(`/research/${encodeURIComponent(id)}/stop`, { method: 'POST' });
  },

  resumeResearch(id: string) {
    return apiFetch<{ session: ResearchSession }>(`/research/${encodeURIComponent(id)}/resume`, {
      method: 'POST',
    });
  },

  getSessionMessages(id: string) {
    return apiFetch<{ messages: SessionMessage[] }>(`/research/${encodeURIComponent(id)}/messages`);
  },

  postSessionMessage(id: string, content: string) {
    return apiFetch<{ userMessage: SessionMessage; assistantMessage: SessionMessage }>(
      `/research/${encodeURIComponent(id)}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({ content }),
      }
    );
  },

  /**
   * Buffered fetch-based SSE subscriber that handles chunked boundaries,
   * Authorization headers, and automatic Last-Event-ID replay.
   */
  subscribeToSessionStream(
    sessionId: string,
    afterSeq: number,
    onEvent: (event: ExecutionEvent) => void,
    onError?: (err: Error) => void
  ): () => void {
    const controller = new AbortController();
    const token = getStoredToken();

    (async () => {
      try {
        const res = await fetch(
          `/api/research/${encodeURIComponent(sessionId)}/stream?afterSeq=${afterSeq}`,
          {
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
            credentials: 'include',
            signal: controller.signal,
          }
        );

        if (!res.ok || !res.body) {
          throw new Error(`Stream connection failed (${res.status})`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const parser = new SseStreamParser();

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          const messages = parser.push(chunk);
          for (const msg of messages) {
            try {
              const parsed = JSON.parse(msg.data) as ExecutionEvent;
              onEvent(parsed);
            } catch {
              // Ignore malformed heartbeat or partial comment
            }
          }
        }
      } catch (err) {
        if (!controller.signal.aborted && onError) {
          onError(err instanceof Error ? err : new Error('Stream disconnected'));
        }
      }
    })();

    return () => {
      controller.abort();
    };
  },
};
