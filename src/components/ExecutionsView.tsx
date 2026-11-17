import React, { useState } from 'react';
import { RotateCcw, Trash2, ArrowUpRight } from 'lucide-react';
import { apiClient } from '../services/apiClient';
import { StatusLabel } from './OverviewDashboard';
import type { ResearchSession } from '../types/research';

interface ExecutionsViewProps {
  sessions: ResearchSession[];
  onOpenExecution: (sessionId: string) => void;
  onOpenReport: (sessionId: string) => void;
  onRefresh: () => Promise<void>;
}

function formatDuration(start: string | null, end: string | null): string {
  if (!start || !end) return '—';
  const diffMs = Math.max(0, new Date(end).getTime() - new Date(start).getTime());
  if (diffMs < 1000) return `${diffMs}ms`;
  const secs = Math.round(diffMs / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

export function ExecutionsView({
  sessions,
  onOpenExecution,
  onOpenReport,
  onRefresh,
}: ExecutionsViewProps) {
  const [filter, setFilter] = useState<'all' | 'active' | 'completed' | 'failed'>('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filtered = sessions.filter((s) => {
    if (filter === 'all') return true;
    if (filter === 'active') {
      return (
        s.status === 'running' ||
        s.status === 'planning' ||
        s.status === 'awaiting_approval' ||
        s.status === 'paused'
      );
    }
    if (filter === 'completed') {
      return s.status === 'completed' || s.status === 'completed_with_warnings';
    }
    return s.status === 'failed' || s.status === 'rejected';
  });

  const handleResume = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await apiClient.resumeResearch(id);
      await onRefresh();
      onOpenExecution(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to resume execution.');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await apiClient.deleteResearchSession(id);
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to delete session.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Workflow Executions
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Audit trail of multi-agent runs, checkpoint states, retries, and execution durations.
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg self-start">
          {(
            [
              ['all', 'All'],
              ['active', 'Active'],
              ['completed', 'Completed'],
              ['failed', 'Failed'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                filter === key
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div role="alert" className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {filtered.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-500">
            No workflow executions match the current filter.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                <tr>
                  <th className="py-3 px-4 font-medium">Research Question</th>
                  <th className="py-3 px-4 font-medium">Status</th>
                  <th className="py-3 px-4 font-medium">Current / Last Agent</th>
                  <th className="py-3 px-4 font-medium text-right">Retries</th>
                  <th className="py-3 px-4 font-medium text-right">Duration</th>
                  <th className="py-3 px-4 font-medium text-right">Started</th>
                  <th className="py-3 px-4 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-50">
                    <td className="py-3 px-4 max-w-xs">
                      <div className="font-medium text-slate-900 truncate">{s.question}</div>
                      {s.errorMessage && (
                        <div className="text-red-600 truncate mt-0.5">{s.errorMessage}</div>
                      )}
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap">
                      <StatusLabel status={s.status} />
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-600 whitespace-nowrap">
                      {s.currentAgent || '—'}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700">
                      {s.retryCount}/{s.maxRetries}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700 whitespace-nowrap">
                      {formatDuration(s.startedAt, s.completedAt)}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-500 whitespace-nowrap">
                      {s.startedAt ? new Date(s.startedAt).toLocaleDateString() : '—'}
                    </td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-2">
                        {(s.status === 'paused' || s.status === 'failed') && (
                          <button
                            type="button"
                            disabled={busyId === s.id}
                            onClick={() => handleResume(s.id)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-amber-300 text-amber-800 hover:bg-amber-50 font-medium"
                          >
                            <RotateCcw className="w-3 h-3" />
                            <span>Resume</span>
                          </button>
                        )}
                        {s.report && (
                          <button
                            type="button"
                            onClick={() => onOpenReport(s.id)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-200 text-slate-700 hover:bg-slate-100 font-medium"
                          >
                            <span>Report</span>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => onOpenExecution(s.id)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-200 text-slate-700 hover:bg-slate-100 font-medium"
                        >
                          <span>Trace</span>
                          <ArrowUpRight className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          disabled={busyId === s.id}
                          onClick={() => handleDelete(s.id)}
                          aria-label={`Delete execution ${s.id}`}
                          className="p-1 text-slate-400 hover:text-red-600"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
