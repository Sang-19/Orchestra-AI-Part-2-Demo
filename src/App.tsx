import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  BookOpen,
  Compass,
  Database,
  FileText,
  Layers,
  LayoutDashboard,
  LogOut,
  Menu,
  Settings,
  Wrench,
  X,
} from 'lucide-react';
import { apiClient, getStoredToken, setStoredToken } from './services/apiClient';
import { AuthView } from './components/AuthView';
import { OverviewDashboard } from './components/OverviewDashboard';
import { NewResearchView } from './components/NewResearchView';
import { WorkflowExecutionView } from './components/WorkflowExecutionView';
import { ResearchReportView } from './components/ResearchReportView';
import { KnowledgeMemoryView } from './components/KnowledgeMemoryView';
import { ExecutionsView } from './components/ExecutionsView';
import { ToolsView } from './components/ToolsView';
import { SettingsView } from './components/SettingsView';
import type {
  CollectionRecord,
  DashboardStats,
  DocumentRecord,
  ResearchSession,
  User,
  UserSettings,
} from './types/research';

type WorkspaceTab =
  | 'overview'
  | 'new_research'
  | 'execution'
  | 'report'
  | 'knowledge'
  | 'executions'
  | 'tools'
  | 'settings';

const NAV_ITEMS: Array<{ id: WorkspaceTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'new_research', label: 'New Research', icon: Compass },
  { id: 'execution', label: 'Workflow Trace', icon: Activity },
  { id: 'report', label: 'Research Reports', icon: FileText },
  { id: 'knowledge', label: 'Knowledge & Memory', icon: Database },
  { id: 'executions', label: 'Executions', icon: BookOpen },
  { id: 'tools', label: 'Tools & APIs', icon: Wrench },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authChecking, setAuthChecking] = useState(true);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('overview');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [sessions, setSessions] = useState<ResearchSession[]>([]);
  const [collections, setCollections] = useState<CollectionRecord[]>([]);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [loadingWorkspace, setLoadingWorkspace] = useState(false);

  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const refreshWorkspace = useCallback(async () => {
    setLoadingWorkspace(true);
    try {
      const [statsRes, sessionsRes, colRes, docRes, settingsRes] = await Promise.all([
        apiClient.getDashboardStats(),
        apiClient.getResearchSessions(),
        apiClient.getCollections(),
        apiClient.getDocuments(),
        apiClient.getSettings(),
      ]);
      setStats(statsRes.stats);
      setSessions(sessionsRes.sessions);
      setCollections(colRes.collections);
      setDocuments(docRes.documents);
      setSettings(settingsRes.settings);
    } catch {
      // Handled by individual views if session expired
    } finally {
      setLoadingWorkspace(false);
    }
  }, []);

  useEffect(() => {
    const token = getStoredToken();
    apiClient
      .checkSession()
      .then((res) => {
        if (!res.user && token) setStoredToken(null);
        setUser(res.user);
      })
      .catch(() => {
        if (token) setStoredToken(null);
        setUser(null);
      })
      .finally(() => {
        setAuthChecking(false);
      });
  }, []);

  useEffect(() => {
    if (user) {
      refreshWorkspace();
    }
  }, [user, refreshWorkspace]);

  const handleLogout = async () => {
    await apiClient.logout();
    setUser(null);
    setStats(null);
    setSessions([]);
    setCollections([]);
    setDocuments([]);
    setActiveSessionId(null);
    setActiveTab('overview');
  };

  const handleOpenSession = (session: ResearchSession) => {
    setActiveSessionId(session.id);
    if (
      session.report &&
      (session.status === 'completed' || session.status === 'completed_with_warnings')
    ) {
      setActiveTab('report');
    } else {
      setActiveTab('execution');
    }
  };

  if (authChecking) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center text-sm text-slate-600">
        Initializing Orchestra AI workspace...
      </div>
    );
  }

  if (!user) {
    return <AuthView onAuthenticated={(u) => setUser(u)} />;
  }

  const activeNav = NAV_ITEMS.find((n) => n.id === activeTab);

  return (
    <div className="min-h-screen bg-slate-50 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col bg-slate-900 text-slate-100 border-r border-slate-800 shrink-0">
        <div className="h-16 px-6 flex items-center gap-3 border-b border-slate-800">
          <div className="w-7 h-7 rounded-md bg-blue-600 flex items-center justify-center shrink-0">
            <Layers className="w-4 h-4 text-white" />
          </div>
          <span className="text-base font-semibold tracking-tight text-white whitespace-nowrap">
            Orchestra AI
          </span>
        </div>

        <nav aria-label="Primary Workspace" className="flex-1 p-4 space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-blue-700 text-white'
                    : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-800 space-y-3">
          <div className="px-2">
            <div className="text-xs font-medium text-white truncate">{user.name}</div>
            <div className="text-xs text-slate-400 truncate">{user.email}</div>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium text-slate-300 hover:bg-slate-800 hover:text-white transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Sign Out</span>
          </button>
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-900/50"
            onClick={() => setMobileNavOpen(false)}
          />
          <aside className="relative w-64 max-w-full bg-slate-900 text-slate-100 flex flex-col z-10">
            <div className="h-16 px-5 flex items-center justify-between border-b border-slate-800">
              <span className="text-base font-semibold text-white">Orchestra AI</span>
              <button
                type="button"
                onClick={() => setMobileNavOpen(false)}
                aria-label="Close navigation menu"
                className="p-1.5 text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <nav className="flex-1 p-4 space-y-1">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const active = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveTab(item.id);
                      setMobileNavOpen(false);
                    }}
                    className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium ${
                      active ? 'bg-blue-700 text-white' : 'text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
            <div className="p-4 border-t border-slate-800">
              <button
                type="button"
                onClick={handleLogout}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium text-slate-300 hover:bg-slate-800"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Sign Out</span>
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Main Content Shell */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-16 bg-white border-b border-slate-200 px-6 flex items-center justify-between gap-6 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              aria-label="Open navigation menu"
              className="lg:hidden p-2 -ml-2 text-slate-600 hover:text-slate-900"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="text-sm text-slate-500 flex items-center gap-2 truncate">
              <span className="font-medium text-slate-900">Workspace</span>
              <span aria-hidden="true">/</span>
              <span className="truncate">{activeNav?.label}</span>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {activeTab !== 'new_research' && (
              <button
                type="button"
                onClick={() => setActiveTab('new_research')}
                className="px-3.5 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-xs font-medium transition-colors whitespace-nowrap shrink-0"
              >
                New Research
              </button>
            )}
          </div>
        </header>

        <main className="flex-1 p-6 lg:p-8 max-w-7xl w-full mx-auto">
          {activeTab === 'overview' && (
            <OverviewDashboard
              stats={stats}
              sessions={sessions}
              documents={documents}
              loading={loadingWorkspace}
              onStartNewResearch={() => setActiveTab('new_research')}
              onOpenSession={handleOpenSession}
              onNavigateTab={(tab) => setActiveTab(tab)}
            />
          )}

          {activeTab === 'new_research' && (
            <NewResearchView
              collections={collections}
              settings={settings}
              onCreatedSession={(session) => {
                setActiveSessionId(session.id);
                setActiveTab('execution');
                refreshWorkspace();
              }}
            />
          )}

          {activeTab === 'execution' && (
            <WorkflowExecutionView
              sessionId={activeSessionId}
              sessions={sessions}
              onSelectSession={(id) => setActiveSessionId(id)}
              onOpenReport={(id) => {
                setActiveSessionId(id);
                setActiveTab('report');
              }}
              onSessionUpdated={refreshWorkspace}
            />
          )}

          {activeTab === 'report' && (
            <ResearchReportView
              sessionId={activeSessionId}
              sessions={sessions}
              onSelectSession={(id) => setActiveSessionId(id)}
            />
          )}

          {activeTab === 'knowledge' && (
            <KnowledgeMemoryView
              collections={collections}
              documents={documents}
              sessions={sessions}
              onRefreshData={refreshWorkspace}
              onOpenSession={handleOpenSession}
            />
          )}

          {activeTab === 'executions' && (
            <ExecutionsView
              sessions={sessions}
              onOpenExecution={(id) => {
                setActiveSessionId(id);
                setActiveTab('execution');
              }}
              onOpenReport={(id) => {
                setActiveSessionId(id);
                setActiveTab('report');
              }}
              onRefresh={refreshWorkspace}
            />
          )}

          {activeTab === 'tools' && <ToolsView />}

          {activeTab === 'settings' && (
            <SettingsView
              user={user}
              settings={settings}
              onUserUpdated={(u) => setUser(u)}
              onSettingsUpdated={(s) => setSettings(s)}
              onHistoryCleared={refreshWorkspace}
            />
          )}
        </main>
      </div>
    </div>
  );
}
