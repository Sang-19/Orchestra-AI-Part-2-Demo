import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  ExternalLink,
  FileCheck2,
  Loader2,
  Play,
  Pause,
  Square,
  Trash2,
  RotateCcw,
  XCircle,
} from 'lucide-react';
import { apiClient } from '../services/apiClient';
import { StatusLabel } from './OverviewDashboard';
import type {
  AgentId,
  ExecutionEvent,
  ResearchPlan,
  ResearchSession,
} from '../types/research';

interface WorkflowExecutionViewProps {
  sessionId: string | null;
  sessions: ResearchSession[];
  onSelectSession: (id: string) => void;
  onOpenReport: (sessionId: string) => void;
  onSessionUpdated: () => void;
}

const AGENT_PIPELINE: Array<{ id: AgentId; label: string; role: string }> = [
  { id: 'input_validation', label: 'Input Validation', role: 'Sanitize & validate bounds' },
  { id: 'planner', label: 'Planner Agent', role: 'Decompose into subtopics' },
  { id: 'human_approval', label: 'Human Approval', role: 'Review & authorize plan' },
  { id: 'research_coordinator', label: 'Research Coordinator', role: 'Dispatch parallel tracks' },
  { id: 'researcher', label: 'Researcher Agents', role: 'Web & RAG retrieval' },
  { id: 'evidence_extraction', label: 'Evidence Extraction', role: 'Attribute claims & quotes' },
  { id: 'fact_checker', label: 'Fact Checker', role: 'Verify against evidence' },
  { id: 'source_credibility', label: 'Source Credibility', role: 'Grade authority & recency' },
  { id: 'contradiction_checker', label: 'Contradiction Checker', role: 'Preserve unresolved conflicts' },
  { id: 'summarizer', label: 'Summarizer Agent', role: 'Topic synthesis & gaps' },
  { id: 'writer', label: 'Writer Agent', role: 'Draft cited report' },
  { id: 'groundedness_checker', label: 'Groundedness Checker', role: 'Audit factual support' },
  { id: 'quality_evaluator', label: 'Quality Evaluator', role: 'Adaptive retry decision' },
];

export function WorkflowExecutionView({
  sessionId,
  sessions,
  onSelectSession,
  onOpenReport,
  onSessionUpdated,
}: WorkflowExecutionViewProps) {
  const [session, setSession] = useState<ResearchSession | null>(null);
  const [events, setEvents] = useState<ExecutionEvent[]>([]);
  const [editablePlan, setEditablePlan] = useState<ResearchPlan | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectBox, setShowRejectBox] = useState(false);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [clockNow, setClockNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const loadSession = async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.getResearchSession(id);
      setSession(res.session);
      setEvents(res.events);
      setEditablePlan(res.session.plan);
      return res;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load session.');
      return null;
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!sessionId) {
      setSession(null);
      setEvents([]);
      return;
    }

    let mounted = true;
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;

    loadSession(sessionId).then((loaded) => {
      if (!mounted || !loaded) return;
      const lastSeq =
        loaded.events.length > 0 ? loaded.events[loaded.events.length - 1].seq : 0;

      unsubscribeRef.current = apiClient.subscribeToSessionStream(
        sessionId,
        lastSeq,
        (evt) => {
          setEvents((prev) => (prev.some((e) => e.seq === evt.seq) ? prev : [...prev, evt]));
          if (
            evt.eventType === 'execution_completed' ||
            evt.eventType === 'execution_failed' ||
            evt.eventType === 'agent_completed' ||
            evt.eventType === 'approval_required' ||
            evt.eventType === 'evidence_discovered' ||
            evt.eventType === 'validation_result' ||
            evt.eventType === 'research_retry'
          ) {
            apiClient
              .getResearchSession(sessionId)
              .then((fresh) => {
                if (mounted) {
                  setSession(fresh.session);
                  if (fresh.session.plan && evt.eventType === 'approval_required') {
                    setEditablePlan(fresh.session.plan);
                  }
                  onSessionUpdated();
                }
              })
              .catch(() => {});
          }
        }
      );
    });

    return () => {
      mounted = false;
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    };
  }, [sessionId]);

  const handleApprove = async () => {
    if (!session) return;
    setActionLoading(true);
    setError(null);
    try {
      const res = await apiClient.approvePlan(session.id, editablePlan ?? undefined);
      setSession(res.session);
      onSessionUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve plan.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleReject = async (revise = false) => {
    if (!session) return;
    setActionLoading(true);
    setError(null);
    try {
      const res = await apiClient.rejectPlan(session.id, rejectReason, revise);
      setSession(res.session);
      if (res.session.plan) {
        setEditablePlan(res.session.plan);
      }
      setRejectReason('');
      setShowRejectBox(false);
      onSessionUpdated();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : revise
            ? 'Failed to revise plan.'
            : 'Failed to reject plan.'
      );
    } finally {
      setActionLoading(false);
    }
  };

  const handlePause = async () => {
    if (!session) return;
    setActionLoading(true); setError(null);
    try { const res = await apiClient.pauseResearch(session.id); setSession(res.session); onSessionUpdated(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Failed to pause workflow.'); }
    finally { setActionLoading(false); }
  };

  const handleStop = async () => {
    if (!session) return;
    if (!window.confirm('Stop this research workflow? It will not resume unless you explicitly start a new workflow.')) return;
    setActionLoading(true); setError(null);
    try { const res = await apiClient.stopResearch(session.id); setSession(res.session); onSessionUpdated(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Failed to stop workflow.'); }
    finally { setActionLoading(false); }
  };

  const handleDelete = async () => {
    if (!session) return;
    if (!window.confirm('Permanently delete this research session, its report, events, messages, and saved checkpoint? This cannot be undone.')) return;
    setActionLoading(true); setError(null);
    try { await apiClient.deleteResearchSession(session.id); onSelectSession(''); onSessionUpdated(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Failed to delete workflow.'); }
    finally { setActionLoading(false); }
  };

  const handleResume = async () => {
    if (!session) return;
    setActionLoading(true);
    setError(null);
    try {
      const res = await apiClient.resumeResearch(session.id);
      setSession(res.session);
      onSessionUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resume execution.');
    } finally {
      setActionLoading(false);
    }
  };

  if (!sessionId) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-10 text-center space-y-4">
        <h2 className="text-lg font-semibold text-slate-900">Select a Research Workflow</h2>
        <p className="text-sm text-slate-600 max-w-md mx-auto">
          Choose an active or completed research session below to inspect its multi-agent execution trace, checkpoints, and evidence.
        </p>
        {sessions.length > 0 && (
          <div className="max-w-lg mx-auto divide-y divide-slate-200 border border-slate-200 rounded-lg text-left">
            {sessions.slice(0, 5).map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => onSelectSession(s.id)}
                className="w-full px-4 py-3 hover:bg-slate-50 flex items-center justify-between gap-3"
              >
                <span className="text-sm text-slate-800 truncate">{s.question}</span>
                <StatusLabel status={s.status} />
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (loading && !session) {
    return (
      <div className="p-12 text-center text-sm text-slate-600 flex items-center justify-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span>Loading workflow state and durable checkpoints...</span>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="p-8 bg-white border border-slate-200 rounded-lg text-sm text-red-700">
        {error || 'Research session not found.'}
      </div>
    );
  }

  const currentCycle = session.executionCycle ?? session.checkpoint?.executionCycle;
  const cycleEvents = events.filter((evt) => !currentCycle?.cycleNumber || (evt.cycleNumber ?? 1) === currentCycle.cycleNumber);
  const eventCompleted = cycleEvents
    .filter((evt) => evt.eventType === 'agent_completed' && evt.agentId)
    .map((evt) => evt.agentId as AgentId);
  const completedSet = new Set<AgentId>([
    ...(currentCycle?.completedAgents ?? session.checkpoint?.completedAgents ?? []),
    ...eventCompleted,
  ]);
  const failedSet = new Set<AgentId>(currentCycle?.failedAgents ?? []);

  // Backward-compatible lifecycle mapping for sessions created before explicit completion
  // events were added for the parallel researcher and groundedness checker stages.
  const researcherCompletion = [...cycleEvents].reverse().find(
    (evt) => evt.agentId === 'researcher' && evt.eventType === 'agent_completed'
  );
  const evidenceFanInStarted = cycleEvents.some(
    (evt) => evt.agentId === 'evidence_extraction' && evt.eventType === 'agent_started'
  );
  if (researcherCompletion || evidenceFanInStarted) {
    const partialFailure = Boolean(researcherCompletion?.payload?.partialFailure);
    if (partialFailure) {
      completedSet.delete('researcher');
      failedSet.add('researcher');
    } else {
      completedSet.add('researcher');
      failedSet.delete('researcher');
    }
  }

  const groundednessResult = [...cycleEvents].reverse().find(
    (evt) => evt.agentId === 'groundedness_checker' && evt.eventType === 'validation_result'
  );
  const groundednessIncomplete = groundednessResult?.payload?.validationStatus === 'incomplete';
  if (groundednessResult) {
    if (groundednessIncomplete) {
      completedSet.delete('groundedness_checker');
      failedSet.add('groundedness_checker');
    } else {
      completedSet.add('groundedness_checker');
      failedSet.delete('groundedness_checker');
    }
  }
  const isAgentFinished = (agentId: AgentId, laterEvents: ExecutionEvent[]) => {
    if (laterEvents.some((evt) => evt.agentId === agentId && ['agent_completed', 'execution_failed'].includes(evt.eventType))) {
      return true;
    }
    // Researcher fan-out is complete only after the fan-in node starts.
    if (agentId === 'researcher') {
      return laterEvents.some((evt) => evt.agentId === 'evidence_extraction' && evt.eventType === 'agent_started');
    }
    // A validation result (including an incomplete timeout result) ends the audit attempt.
    if (agentId === 'groundedness_checker') {
      return laterEvents.some((evt) => evt.agentId === 'groundedness_checker' && evt.eventType === 'validation_result');
    }
    return false;
  };
  const latestAgentStart = [...cycleEvents].reverse().find((evt, index, reversed) =>
    evt.eventType === 'agent_started' && evt.agentId &&
    !isAgentFinished(evt.agentId, reversed.slice(0, index))
  );
  const latestApproval = [...cycleEvents].reverse().find((evt) => evt.eventType === 'approval_required');
  const activeAgentFromEvents = latestApproval && (!latestAgentStart || latestApproval.seq > latestAgentStart.seq)
    ? 'human_approval' as AgentId
    : latestAgentStart?.agentId ?? null;
  const agentElapsedSeconds = latestAgentStart ? Math.max(0, Math.floor((clockNow - new Date(latestAgentStart.createdAt).getTime()) / 1000)) : 0;
  const requestTimeoutMs = Number(latestAgentStart?.payload?.timeoutMs) || 90_000;
  const agentTimedOut = Boolean(latestAgentStart && agentElapsedSeconds * 1000 >= requestTimeoutMs && ['planning', 'running'].includes(session.status));
  const sources = session.checkpoint?.sources ?? [];
  const claims = session.checkpoint?.claims ?? [];
  const canViewReport =
    Boolean(session.report) &&
    (session.status === 'completed' || session.status === 'completed_with_warnings');

  return (
    <div className="space-y-6">
      {/* Top Summary Banner */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <StatusLabel status={session.status} />
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">ID: {session.id.slice(0, 14)}</span>
            <span aria-hidden="true">·</span>
            <span className="capitalize">{session.provider ?? 'gemini'}</span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">
              Adaptive retries: {session.retryCount}/{session.maxRetries} · Cycle {currentCycle?.cycleNumber ?? session.retryCount + 1}
            </span>
          </div>
          <h1 className="mt-1.5 text-xl font-semibold text-slate-900">{session.question}</h1>
          {latestAgentStart && ['planning', 'running'].includes(session.status) && (
            <div className={`mt-3 flex flex-wrap items-center gap-2 text-xs ${agentTimedOut ? 'text-red-700' : 'text-slate-600'}`} role="status" aria-live="polite">
              <span className={`inline-block h-2 w-2 rounded-full ${agentTimedOut ? 'bg-red-600' : 'bg-blue-600 animate-pulse'}`} />
              <span>{latestAgentStart.agentId?.replace(/_/g, ' ')} {agentTimedOut ? 'has exceeded the 90-second request budget; waiting for the backend timeout and retry handler.' : 'is executing'} · {Math.floor(agentElapsedSeconds / 60)}m {agentElapsedSeconds % 60}s elapsed</span>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          {sessions.length > 1 && (
            <select
              aria-label="Switch research session"
              value={session.id}
              onChange={(e) => onSelectSession(e.target.value)}
              className="px-3 py-2 text-xs rounded-lg border border-slate-200 bg-white text-slate-700 max-w-[220px]"
            >
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.question.slice(0, 48)}
                </option>
              ))}
            </select>
          )}

          {['running', 'planning'].includes(session.status) && (
            <>
              <button type="button" onClick={handlePause} disabled={actionLoading} className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-amber-300 text-amber-700 hover:bg-amber-50 disabled:opacity-60 text-xs font-medium whitespace-nowrap">
                <Pause className="w-3.5 h-3.5" /> Pause
              </button>
              <button type="button" onClick={handleStop} disabled={actionLoading} className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-60 text-xs font-medium whitespace-nowrap">
                <Square className="w-3.5 h-3.5" /> Stop
              </button>
            </>
          )}
          {session.status === 'paused' && (
            <button type="button" onClick={handleStop} disabled={actionLoading} className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-60 text-xs font-medium whitespace-nowrap">
              <Square className="w-3.5 h-3.5" /> Stop
            </button>
          )}
          {['completed', 'completed_with_warnings', 'failed', 'stopped', 'rejected', 'paused', 'awaiting_approval'].includes(session.status) && (
            <button type="button" onClick={handleDelete} disabled={actionLoading} className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-60 text-xs font-medium whitespace-nowrap">
              <Trash2 className="w-3.5 h-3.5" /> Delete
            </button>
          )}
          {(session.status === 'paused' || session.status === 'failed') && (
            <button
              type="button"
              onClick={handleResume}
              disabled={actionLoading}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium whitespace-nowrap"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Resume from Checkpoint</span>
            </button>
          )}

          {canViewReport && (
            <button
              type="button"
              onClick={() => onOpenReport(session.id)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-xs font-medium whitespace-nowrap"
            >
              <FileCheck2 className="w-3.5 h-3.5" />
              <span>Open Research Report</span>
            </button>
          )}
        </div>
      </div>

      {error && (
        <div role="alert" className="p-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          {error}
        </div>
      )}

      {session.errorMessage && (
        <div className="p-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">Execution Notice</div>
            <div className="mt-0.5">{session.errorMessage}</div>
          </div>
        </div>
      )}

      {/* Human Approval Interrupt Gate */}
      {session.status === 'awaiting_approval' && editablePlan && (
        <div className="bg-white border border-amber-300 rounded-xl p-6 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-4 border-b border-slate-200">
            <div>
              <div className="text-xs font-semibold text-amber-700">
                Human Approval Gate · Workflow Paused at Checkpoint
              </div>
              <h2 className="mt-1 text-lg font-semibold text-slate-900">
                Review Proposed Research Plan
              </h2>
            </div>
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => setShowRejectBox((v) => !v)}
                disabled={actionLoading}
                className="px-3.5 py-2 rounded-lg border border-slate-300 hover:bg-slate-50 text-xs font-medium text-slate-700 whitespace-nowrap"
              >
                Reject Plan
              </button>
              <button
                type="button"
                onClick={handleApprove}
                disabled={actionLoading}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-60 text-white text-xs font-medium whitespace-nowrap"
              >
                <Play className="w-3.5 h-3.5" />
                <span>{actionLoading ? 'Dispatching...' : 'Approve & Execute Research'}</span>
              </button>
            </div>
          </div>

          {showRejectBox && (
            <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 space-y-3">
              <label htmlFor="reject-reason" className="block text-xs font-medium text-slate-700">
                Feedback or Rejection Reason
              </label>
              <input
                id="reject-reason"
                type="text"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="e.g., Narrow scope to North American regulations and add cost benchmarks"
                className="w-full px-3 py-2 text-sm rounded-md border border-slate-300 bg-white"
              />
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowRejectBox(false)}
                  disabled={actionLoading}
                  className="px-3 py-1.5 text-xs text-slate-600"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => handleReject(true)}
                  disabled={actionLoading}
                  className="px-3 py-1.5 rounded-md bg-amber-600 hover:bg-amber-700 disabled:opacity-60 text-white text-xs font-medium whitespace-nowrap"
                >
                  {actionLoading ? 'Re-planning...' : 'Revise Plan with Feedback'}
                </button>
                <button
                  type="button"
                  onClick={() => handleReject(false)}
                  disabled={actionLoading}
                  className="px-3 py-1.5 rounded-md bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-xs font-medium whitespace-nowrap"
                >
                  Confirm Rejection
                </button>
              </div>
            </div>
          )}

          <div>
            <label htmlFor="plan-objective" className="block text-xs font-medium text-slate-700 mb-1.5">
              Research Objective (Editable)
            </label>
            <input
              id="plan-objective"
              type="text"
              value={editablePlan.objective}
              onChange={(e) =>
                setEditablePlan({ ...editablePlan, objective: e.target.value })
              }
              className="w-full px-3.5 py-2 text-sm rounded-lg border border-slate-300"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {editablePlan.subtopics.map((sub, idx) => (
              <div key={sub.id} className="p-4 rounded-lg border border-slate-200 bg-slate-50/50 space-y-2">
                <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
                  <span className="font-mono">Subtopic 0{idx + 1}</span>
                  <span className="capitalize">Priority: {sub.priority}</span>
                </div>
                <input
                  type="text"
                  aria-label={`Subtopic ${idx + 1} title`}
                  value={sub.title}
                  onChange={(e) => {
                    const next = [...editablePlan.subtopics];
                    next[idx] = { ...sub, title: e.target.value };
                    setEditablePlan({ ...editablePlan, subtopics: next });
                  }}
                  className="w-full px-2.5 py-1.5 text-sm font-medium rounded border border-slate-200 bg-white"
                />
                <p className="text-xs text-slate-600 leading-relaxed">{sub.description}</p>
                <div className="text-xs text-slate-500">
                  Queries: <span className="font-mono text-slate-700">{sub.searchQueries.join(' | ')}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Main 2-column Grid: Pipeline Stages + Live Stream / Evidence */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: 13-stage Graph Pipeline */}
        <div className="bg-white border border-slate-200 rounded-xl p-6">
          <h2 className="text-base font-semibold text-slate-900 mb-4">Agent Pipeline Graph</h2>
          <ol className="space-y-3">
            {AGENT_PIPELINE.map((stage) => {
              const isDone = completedSet.has(stage.id);
              const isFailed = failedSet.has(stage.id);
              const isCurrent =
                (activeAgentFromEvents === stage.id || (!activeAgentFromEvents && session.currentAgent === stage.id)) &&
                (session.status === 'running' ||
                  session.status === 'planning' ||
                  session.status === 'awaiting_approval');
              const isFailedHere = isFailed || (session.status === 'failed' && session.currentAgent === stage.id);

              return (
                <li key={stage.id} className="flex items-start gap-3">
                  <div className="mt-0.5 shrink-0">
                    {isFailedHere ? (
                      <XCircle className="w-4 h-4 text-red-600" />
                    ) : isDone ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    ) : isCurrent ? (
                      <Loader2 className="w-4 h-4 text-blue-700 animate-spin" />
                    ) : (
                      <Circle className="w-4 h-4 text-slate-300" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <div
                      className={`text-sm font-medium ${
                        isCurrent
                          ? 'text-blue-700'
                          : isDone
                            ? 'text-slate-900'
                            : 'text-slate-500'
                      }`}
                    >
                      {stage.label}
                    </div>
                    <div className="text-xs text-slate-500">{stage.role}</div>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>

        {/* Right: Real-Time Event Log + Collected Evidence */}
        <div className="lg:col-span-2 space-y-6">
          {/* Live SSE Trace */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-900">Real-Time Execution Trace</h2>
              <span className="text-xs font-mono text-slate-500 tabular-nums">
                {events.length} events
              </span>
            </div>
            <div className="max-h-72 overflow-y-auto divide-y divide-slate-100">
              {events.length === 0 ? (
                <div className="p-6 text-sm text-slate-500">Waiting for backend workflow events...</div>
              ) : (
                events.map((evt, index) => (
                  <React.Fragment key={evt.id}>
                  {(index === 0 || evt.cycleNumber !== events[index - 1]?.cycleNumber) && <div className="px-6 py-2 bg-slate-50 border-y border-slate-200 text-xs font-semibold text-slate-600">Cycle {evt.cycleNumber ?? 1} · {(evt.cycleNumber ?? 1) === 1 ? 'Initial execution' : 'Adaptive retry'}</div>}
                  <div className="px-6 py-3 flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-xs text-slate-500 font-mono">
                        #{evt.seq} · {evt.eventType} · Cycle {evt.cycleNumber ?? 1}
                        {evt.agentId ? ` · ${evt.agentId}` : ''}
                      </div>
                      <div className="mt-0.5 text-sm text-slate-800">{evt.message}</div>
                    </div>
                    <span className="text-xs font-mono text-slate-400 tabular-nums shrink-0">
                      {new Date(evt.createdAt).toLocaleTimeString()}
                    </span>
                  </div>
                  </React.Fragment>
                ))
              )}
            </div>
          </div>

          {/* Sources & Claims Inspector */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-900">
                Discovered Sources & Extracted Claims
              </h2>
              <span className="text-xs font-mono text-slate-500 tabular-nums">
                {sources.length} sources · {claims.length} claims
              </span>
            </div>

            {sources.length === 0 && claims.length === 0 ? (
              <div className="p-6 text-sm text-slate-500">
                Sources and factual claims will populate here as the Researcher and Fact Checker agents execute.
              </div>
            ) : (
              <div className="p-6 space-y-6">
                {sources.length > 0 && (
                  <div className="space-y-2.5">
                    <div className="text-xs font-semibold text-slate-700">Sources</div>
                    {sources.map((src) => (
                      <div
                        key={src.id}
                        className="p-3.5 rounded-lg border border-slate-200 flex items-start justify-between gap-3"
                      >
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-slate-900">
                            [{src.citationNumber}] {src.title}
                          </div>
                          <div className="mt-0.5 text-xs text-slate-500 tabular-nums">
                            {src.domain} · {src.credibilityTier} · Credibility{' '}
                            {Math.round(src.credibilityScore * 100)}%
                          </div>
                          <p className="mt-1.5 text-xs text-slate-600 line-clamp-2">{src.snippet}</p>
                        </div>
                        {src.url.startsWith('http') && (
                          <a
                            href={src.url}
                            target="_blank"
                            rel="noreferrer"
                            aria-label={`Open ${src.title}`}
                            className="p-1.5 text-slate-500 hover:text-blue-700 shrink-0"
                          >
                            <ExternalLink className="w-4 h-4" />
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {claims.length > 0 && (
                  <div className="space-y-2.5">
                    <div className="text-xs font-semibold text-slate-700">Verified Claims</div>
                    {claims.map((clm) => (
                      <div key={clm.id} className="p-3.5 rounded-lg border border-slate-200">
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span
                            className={`font-medium capitalize ${
                              clm.verificationStatus === 'supported'
                                ? 'text-emerald-700'
                                : clm.verificationStatus === 'unsupported'
                                  ? 'text-red-700'
                                  : 'text-amber-700'
                            }`}
                          >
                            {clm.verificationStatus.replace('_', ' ')}
                          </span>
                          <span className="font-mono text-slate-500 tabular-nums">
                            Confidence {Math.round(clm.confidenceScore * 100)}%
                          </span>
                        </div>
                        <div className="mt-1 text-sm text-slate-900">{clm.statement}</div>
                        <div className="mt-1 text-xs text-slate-500">{clm.verificationReasoning}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
