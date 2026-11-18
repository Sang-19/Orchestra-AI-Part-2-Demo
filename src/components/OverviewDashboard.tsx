import React from 'react';
import { ArrowUpRight, CheckCircle2, Clock, FileText, AlertTriangle } from 'lucide-react';
import type { DashboardStats, DocumentRecord, ResearchSession } from '../types/research';

interface OverviewDashboardProps {
  stats: DashboardStats | null;
  sessions: ResearchSession[];
  documents: DocumentRecord[];
  loading: boolean;
  onStartNewResearch: () => void;
  onOpenSession: (session: ResearchSession) => void;
  onNavigateTab: (tab: 'knowledge' | 'executions' | 'tools') => void;
}

export function StatusLabel({ status }: { status: ResearchSession['status'] }) {
  const map: Record<ResearchSession['status'], { label: string; className: string }> = {
    planning: { label: 'Planning', className: 'text-blue-700' },
    awaiting_approval: { label: 'Awaiting Approval', className: 'text-amber-700' },
    running: { label: 'Running', className: 'text-blue-700' },
    paused: { label: 'Paused Checkpoint', className: 'text-amber-700' },
    stopped: { label: 'Stopped', className: 'text-slate-600' },
    rejected: { label: 'Rejected', className: 'text-slate-600' },
    completed: { label: 'Verified Complete', className: 'text-emerald-700' },
    completed_with_warnings: { label: 'Complete (Warnings)', className: 'text-amber-700' },
    failed: { label: 'Failed', className: 'text-red-700' },
  };
  const cfg = map[status] ?? { label: status, className: 'text-slate-700' };
  return <span className={`font-medium text-xs ${cfg.className}`}>{cfg.label}</span>;
}

export function OverviewDashboard({
  stats,
  sessions,
  documents,
  loading,
  onStartNewResearch,
  onOpenSession,
  onNavigateTab,
}: OverviewDashboardProps) {
  if (loading && !stats) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-24 bg-white border border-slate-200 rounded-lg animate-pulse" />
          ))}
        </div>
        <div className="h-64 bg-white border border-slate-200 rounded-lg animate-pulse" />
      </div>
    );
  }

  const metrics = [
    {
      label: 'Total Research Sessions',
      value: stats?.totalSessions ?? 0,
      detail: `${stats?.completedSessions ?? 0} completed`,
    },
    {
      label: 'Active / Pending Approval',
      value: (stats?.activeSessions ?? 0) + (stats?.awaitingApprovalSessions ?? 0),
      detail: `${stats?.awaitingApprovalSessions ?? 0} awaiting plan review`,
    },
    {
      label: 'Failed / Rejected',
      value: stats?.failedSessions ?? 0,
      detail: 'Available for inspection',
    },
    {
      label: 'Indexed Documents',
      value: stats?.totalDocuments ?? 0,
      detail: `${stats?.totalChunks ?? 0} vector chunks`,
    },
    {
      label: 'Average Groundedness',
      value:
        stats?.averageGroundedness !== null && stats?.averageGroundedness !== undefined
          ? `${Math.round(stats.averageGroundedness * 100)}%`
          : '—',
      detail: `${stats?.totalClaimsVerified ?? 0} claims audited`,
    },
  ];

  return (
    <div className="space-y-8">
      {/* Header row */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Research Workspace Overview
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Live database metrics across your research pipelines, checkpoints, and knowledge base.
        </p>
      </div>

      {/* Real KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 sm:gap-4">
        {metrics.map((m) => (
          <div key={m.label} className="bg-white border border-slate-200 rounded-lg p-5">
            <div className="text-xs font-medium text-slate-500">{m.label}</div>
            <div className="mt-2 text-2xl font-semibold text-slate-900 tabular-nums font-mono">
              {m.value}
            </div>
            <div className="mt-1 text-xs text-slate-500 tabular-nums">{m.detail}</div>
          </div>
        ))}
      </div>

      {/* Main Split: Recent Research + Knowledge Base */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
            <h2 className="text-base font-semibold text-slate-900">Recent Research Sessions</h2>
            <button
              type="button"
              onClick={() => onNavigateTab('executions')}
              className="text-xs font-medium text-blue-700 hover:text-blue-900 whitespace-nowrap shrink-0"
            >
              View All Executions
            </button>
          </div>

          {sessions.length === 0 ? (
            <div className="p-10 text-center">
              <p className="text-sm text-slate-600">
                No research sessions recorded yet in this workspace.
              </p>
              <button
                type="button"
                onClick={onStartNewResearch}
                className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 text-white text-xs font-medium hover:bg-slate-800"
              >
                Start First Research Investigation
              </button>
            </div>
          ) : (
            <div className="divide-y divide-slate-200">
              {sessions.slice(0, 6).map((s) => (
                <div
                  key={s.id}
                  className="px-6 py-4 hover:bg-slate-50 transition-colors flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
                >
                  <div className="min-w-0">
                    <button
                      type="button"
                      onClick={() => onOpenSession(s)}
                      className="text-left text-sm font-medium text-slate-900 hover:text-blue-700 transition-colors line-clamp-1"
                    >
                      {s.question}
                    </button>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <StatusLabel status={s.status} />
                      <span aria-hidden="true">·</span>
                      <span className="capitalize">{s.mode.replace('_', ' ')}</span>
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums">
                        {s.checkpoint?.sources.length ?? 0} sources
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums">
                        {new Date(s.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onOpenSession(s)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap shrink-0"
                  >
                    <span>
                      {s.status === 'completed' || s.status === 'completed_with_warnings'
                        ? 'Open Report'
                        : s.status === 'awaiting_approval'
                          ? 'Review Plan'
                          : 'Inspect'}
                    </span>
                    <ArrowUpRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden flex flex-col">
          <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
            <h2 className="text-base font-semibold text-slate-900">Knowledge Memory</h2>
            <button
              type="button"
              onClick={() => onNavigateTab('knowledge')}
              className="text-xs font-medium text-blue-700 hover:text-blue-900 whitespace-nowrap shrink-0"
            >
              Manage Files
            </button>
          </div>

          <div className="p-6 flex-1 flex flex-col justify-between space-y-5">
            {documents.length === 0 ? (
              <div className="text-sm text-slate-500">
                Upload PDF, DOCX, Markdown, or text briefings to enable private RAG retrieval.
              </div>
            ) : (
              <div className="space-y-3">
                {documents.slice(0, 5).map((doc) => (
                  <div
                    key={doc.id}
                    className="flex items-start justify-between gap-3 pb-3 border-b border-slate-100 last:border-0 last:pb-0"
                  >
                    <div className="min-w-0 flex items-start gap-2.5">
                      <FileText className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-slate-800 truncate">
                          {doc.filename}
                        </div>
                        <div className="text-xs text-slate-500 tabular-nums">
                          {doc.chunkCount} chunks · {doc.collectionName || 'Unassigned'}
                        </div>
                      </div>
                    </div>
                    {doc.status === 'indexed' ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    ) : doc.status === 'failed' ? (
                      <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                    ) : (
                      <Clock className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                    )}
                  </div>
                ))}
              </div>
            )}

            <button
              type="button"
              onClick={() => onNavigateTab('knowledge')}
              className="w-full py-2 px-3 rounded-lg border border-slate-200 hover:bg-slate-50 text-xs font-medium text-slate-700 transition-colors whitespace-nowrap"
            >
              Upload or Search Knowledge Base
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
