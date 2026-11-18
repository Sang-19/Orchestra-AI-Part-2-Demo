import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Command } from '@langchain/langgraph';
import { getDb } from '../db/database';
import { createInitialCheckpoint, validateResearchInput } from './stateMachine';
import {
  projectGraphStateToCheckpoint,
  type HumanApprovalResumePayload,
  type OrchestraGraphState,
} from './graphState';
import {
  createOrchestraResearchGraph,
  type GraphAgentDependencies,
  type GraphEventPayload,
} from './researchGraph';
import { getSqliteCheckpointer } from './sqliteCheckpointer';
import { runWithModelRouting, DEFAULT_AGENT_MODEL_ROUTING, normalizeModelRouting } from '../ai/modelRouter';
import type {
  AgentId,
  ExecutionEvent,
  ResearchMode,
  ResearchPlan,
  ResearchSession,
  ResearchStatus,
  UserSettings,
  WorkflowCheckpoint,
} from '../../src/types/research';

class SessionEventBus extends EventEmitter {
  emitSessionEvent(sessionId: string, event: ExecutionEvent): void {
    this.emit(`session:${sessionId}`, event);
  }
}

export const sessionBus = new SessionEventBus();
const activeRuns = new Set<string>();
const pendingRunControls = new Map<string, 'pause' | 'stop'>();
let customAgentOverrides: Partial<GraphAgentDependencies> | undefined;

/**
 * Optional dependency injection hook used by deterministic integration tests.
 */
export function setWorkflowAgentOverrides(overrides?: Partial<GraphAgentDependencies>): void {
  customAgentOverrides = overrides;
}

function appendExecutionEvent(params: GraphEventPayload): ExecutionEvent {
  const db = getDb();
  const now = new Date().toISOString();
  const row = db
    .prepare(`SELECT COALESCE(MAX(seq), 0) as maxSeq FROM execution_events WHERE session_id = ?`)
    .get(params.sessionId) as { maxSeq: number };

  const payload = params.payload ?? null;
  const cpRow = db.prepare("SELECT checkpoint_json FROM research_sessions WHERE id = ?").get(params.sessionId) as { checkpoint_json?: string } | undefined;
  let cycleNumber = 1;
  if (cpRow?.checkpoint_json) { try { const cp = JSON.parse(cpRow.checkpoint_json) as WorkflowCheckpoint; cycleNumber = cp.executionCycle?.cycleNumber ?? cp.retryCount + 1; } catch { /* tolerate legacy checkpoint */ } }
  if (params.eventType === 'research_retry' && payload?.routeAction === 'retry_research') cycleNumber += 1;

  const evt: ExecutionEvent = {
    id: `evt-${crypto.randomUUID()}`,
    sessionId: params.sessionId,
    seq: row.maxSeq + 1,
    cycleNumber,
    eventType: params.eventType,
    agentId: params.agentId,
    message: params.message,
    payload,
    createdAt: now,
  };

  db.prepare(`
    INSERT INTO execution_events (id, session_id, seq, event_type, agent_id, message, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    evt.id,
    evt.sessionId,
    evt.seq,
    evt.eventType,
    evt.agentId,
    evt.message,
    evt.payload ? JSON.stringify(evt.payload) : null,
    evt.createdAt
  );

  sessionBus.emitSessionEvent(params.sessionId, evt);
  return evt;
}

function saveSessionProjection(params: {
  sessionId: string;
  status: ResearchStatus;
  checkpoint: WorkflowCheckpoint;
  completedAt?: string | null;
  errorMessage?: string | null;
}): void {
  const db = getDb();
  const now = new Date().toISOString();
  params.checkpoint.lastUpdatedAt = now;

  db.prepare(`
    UPDATE research_sessions
    SET status = ?,
        retry_count = ?,
        current_agent = ?,
        plan_json = ?,
        checkpoint_json = ?,
        report_json = ?,
        groundedness_json = ?,
        quality_json = ?,
        error_message = ?,
        completed_at = COALESCE(?, completed_at),
        updated_at = ?
    WHERE id = ?
  `).run(
    params.status,
    params.checkpoint.retryCount,
    params.checkpoint.currentStep,
    params.checkpoint.plan ? JSON.stringify(params.checkpoint.plan) : null,
    JSON.stringify(params.checkpoint),
    params.checkpoint.report ? JSON.stringify(params.checkpoint.report) : null,
    params.checkpoint.groundedness ? JSON.stringify(params.checkpoint.groundedness) : null,
    params.checkpoint.quality ? JSON.stringify(params.checkpoint.quality) : null,
    params.errorMessage ?? null,
    params.completedAt ?? null,
    now,
    params.sessionId
  );
}

function buildWorkflowGraph() {
  return createOrchestraResearchGraph({
    checkpointer: getSqliteCheckpointer(),
    agents: customAgentOverrides,
    onEvent: (evt) => {
      appendExecutionEvent(evt);
    },
  });
}

function makeThreadConfig(sessionId: string, userId: string) {
  return {
    configurable: {
      thread_id: sessionId,
      user_id: userId,
    },
    recursionLimit: 60,
  };
}

export function getUserSettings(userId: string): UserSettings {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM user_settings WHERE user_id = ?`)
    .get(userId) as
    | {
        user_id: string;
        default_mode: ResearchMode;
        max_retries: number;
        groundedness_threshold: number;
        citation_style: UserSettings['citationStyle'];
        report_tone: UserSettings['reportTone'];
        include_web_default: number;
        include_rag_default: number;
        notify_on_complete: number;
        notify_on_failure: number;
        model_routing_json?: string;
        updated_at: string;
      }
    | undefined;

  if (!row) {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO user_settings (user_id, updated_at) VALUES (?, ?)`).run(userId, now);
    return {
      userId,
      defaultMode: 'standard',
      maxRetries: 2,
      groundednessThreshold: 0.75,
      citationStyle: 'numeric',
      reportTone: 'executive',
      includeWebDefault: true,
      includeRagDefault: true,
      notifyOnComplete: true,
      notifyOnFailure: true,
      modelRouting: DEFAULT_AGENT_MODEL_ROUTING,
      updatedAt: now,
    };
  }

  return {
    userId: row.user_id,
    defaultMode: row.default_mode,
    maxRetries: row.max_retries,
    groundednessThreshold: row.groundedness_threshold,
    citationStyle: row.citation_style,
    reportTone: row.report_tone,
    includeWebDefault: Boolean(row.include_web_default),
    includeRagDefault: Boolean(row.include_rag_default),
    notifyOnComplete: Boolean(row.notify_on_complete),
    notifyOnFailure: Boolean(row.notify_on_failure),
    modelRouting: normalizeModelRouting(row.model_routing_json ? JSON.parse(row.model_routing_json) : {}),
    updatedAt: row.updated_at,
  };
}

export function getResearchSession(sessionId: string, userId: string): ResearchSession | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM research_sessions WHERE id = ? AND user_id = ?`)
    .get(sessionId, userId) as Record<string, unknown> | undefined;

  if (!row) return null;
  return mapSessionRow(row);
}

export function mapSessionRow(row: Record<string, unknown>): ResearchSession {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    question: String(row.question),
    mode: row.mode as ResearchMode,
    status: row.status as ResearchStatus,
    includeWeb: Boolean(row.include_web),
    includeRag: Boolean(row.include_rag),
    collectionIds: JSON.parse(String(row.collection_ids_json || '[]')) as string[],
    maxRetries: Number(row.max_retries),
    retryCount: Number(row.retry_count),
    currentAgent: (row.current_agent as AgentId | null) ?? null,
    executionCycle: row.checkpoint_json ? (JSON.parse(String(row.checkpoint_json)) as WorkflowCheckpoint).executionCycle : undefined,
    plan: row.plan_json ? (JSON.parse(String(row.plan_json)) as ResearchPlan) : null,
    checkpoint: row.checkpoint_json
      ? (JSON.parse(String(row.checkpoint_json)) as WorkflowCheckpoint)
      : null,
    report: row.report_json
      ? (JSON.parse(String(row.report_json)) as ResearchSession['report'])
      : null,
    groundedness: row.groundedness_json
      ? (JSON.parse(String(row.groundedness_json)) as ResearchSession['groundedness'])
      : null,
    quality: row.quality_json
      ? (JSON.parse(String(row.quality_json)) as ResearchSession['quality'])
      : null,
    errorMessage: (row.error_message as string | null) ?? null,
    startedAt: (row.started_at as string | null) ?? null,
    completedAt: (row.completed_at as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * Streams a LangGraph invocation or resumption while projecting each state transition
 * into `research_sessions` for real-time API & frontend visibility.
 */
async function runGraphStreamAndSync(params: { sessionId: string; userId: string; input: Record<string, unknown> | Command | null }): Promise<void> {
  const graph = buildWorkflowGraph();
  const config = makeThreadConfig(params.sessionId, params.userId);
  let latestState: OrchestraGraphState | null = null;
  try {
    await runWithModelRouting(getUserSettings(params.userId).modelRouting, async () => {
      const stream = await graph.stream(params.input as never, { ...config, streamMode: 'values' });
      for await (const snapshot of stream) {
        latestState = snapshot as unknown as OrchestraGraphState;
        if (latestState?.sessionId) saveSessionProjection({ sessionId: params.sessionId, status: latestState.status, checkpoint: projectGraphStateToCheckpoint(latestState), errorMessage: latestState.errorMessage });
        if (pendingRunControls.has(params.sessionId)) break;
      }
      const finalSnapshot = await graph.getState(config);
      const finalValues = (finalSnapshot.values as OrchestraGraphState | undefined) ?? latestState;
      if (!finalValues) return;
      const projected = projectGraphStateToCheckpoint(finalValues);
      const requestedControl = pendingRunControls.get(params.sessionId);
      if (requestedControl) {
        pendingRunControls.delete(params.sessionId);
        const stopped = requestedControl === 'stop';
        saveSessionProjection({
          sessionId: params.sessionId,
          status: stopped ? 'stopped' : 'paused',
          checkpoint: projected,
          completedAt: stopped ? new Date().toISOString() : null,
          errorMessage: stopped ? 'Execution stopped by user.' : null,
        });
        appendExecutionEvent({
          sessionId: params.sessionId,
          eventType: stopped ? 'execution_stopped' : 'execution_paused',
          agentId: projected.currentStep,
          message: stopped ? 'Execution stopped by user at a durable checkpoint.' : 'Execution paused at a durable checkpoint.',
        });
        return;
      }
      const pendingNodes = Array.isArray(finalSnapshot.next) ? finalSnapshot.next : [];
      if (pendingNodes.includes('human_approval')) {
        saveSessionProjection({ sessionId: params.sessionId, status: 'awaiting_approval', checkpoint: { ...projected, currentStep: 'human_approval' }, errorMessage: null });
        return;
      }
      const terminal = pendingNodes.length === 0 && ['rejected','completed','completed_with_warnings','failed'].includes(finalValues.status);
      if (!terminal) {
        saveSessionProjection({ sessionId: params.sessionId, status: finalValues.status === 'failed' ? 'failed' : 'running', checkpoint: projected, errorMessage: finalValues.errorMessage ?? (pendingNodes.length ? `Workflow has pending graph nodes: ${pendingNodes.join(', ')}` : 'Workflow stream ended before a terminal graph state was recorded.') });
        return;
      }
      saveSessionProjection({ sessionId: params.sessionId, status: finalValues.status, checkpoint: projected, completedAt: new Date().toISOString(), errorMessage: finalValues.errorMessage });
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected LangGraph execution error.';
    const current = getResearchSession(params.sessionId, params.userId);
    const checkpoint = (latestState ? projectGraphStateToCheckpoint(latestState) : current?.checkpoint) ?? createInitialCheckpoint(params.sessionId, current?.maxRetries ?? 2);
    saveSessionProjection({ sessionId: params.sessionId, status: 'failed', checkpoint, completedAt: new Date().toISOString(), errorMessage: message });
    appendExecutionEvent({ sessionId: params.sessionId, eventType: 'execution_failed', agentId: checkpoint.currentStep, message });
  }
}

export async function createAndPlanResearch(params: {
  userId: string;
  question: string;
  mode?: ResearchMode;
  includeWeb?: boolean;
  includeRag?: boolean;
  collectionIds?: string[];
  maxRetries?: number;
}): Promise<ResearchSession> {
  const validation = validateResearchInput(params.question);
  if (!validation.valid) {
    throw new Error(validation.reason);
  }

  const settings = getUserSettings(params.userId);
  const mode = params.mode ?? settings.defaultMode;
  const maxRetries = Math.min(4, Math.max(0, params.maxRetries ?? settings.maxRetries));
  const includeWeb = params.includeWeb ?? settings.includeWebDefault;
  const includeRag = params.includeRag ?? settings.includeRagDefault;
  const collectionIds = params.collectionIds ?? [];

  if (!includeWeb && !includeRag) {
    throw new Error('Select at least one knowledge source (Web Search or Knowledge Base).');
  }

  const db = getDb();
  const sessionId = `res-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const initialCheckpoint = createInitialCheckpoint(sessionId, maxRetries);

  db.prepare(`
    INSERT INTO research_sessions (
      id, user_id, question, mode, status, include_web, include_rag, collection_ids_json,
      max_retries, retry_count, current_agent, checkpoint_json, started_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'planning', ?, ?, ?, ?, 0, 'input_validation', ?, ?, ?, ?)
  `).run(
    sessionId,
    params.userId,
    params.question.trim(),
    mode,
    includeWeb ? 1 : 0,
    includeRag ? 1 : 0,
    JSON.stringify(collectionIds),
    maxRetries,
    JSON.stringify(initialCheckpoint),
    now,
    now,
    now
  );

  // Execute LangGraph from START until it pauses at the `human_approval` interrupt()
  await runGraphStreamAndSync({
    sessionId,
    userId: params.userId,
    input: {
      sessionId,
      userId: params.userId,
      question: params.question.trim(),
      mode,
      includeWeb,
      includeRag,
      collectionIds,
      maxRetries,
      groundednessThreshold: settings.groundednessThreshold,
      reportTone: settings.reportTone,
      citationStyle: settings.citationStyle,
    },
  });

  return getResearchSession(sessionId, params.userId)!;
}

function dispatchLangGraphResumeAsync(params: {
  sessionId: string;
  userId: string;
  input: Command | null;
}): void {
  if (activeRuns.has(params.sessionId)) return;
  pendingRunControls.delete(params.sessionId);
  activeRuns.add(params.sessionId);

  void runGraphStreamAndSync(params).finally(() => {
    activeRuns.delete(params.sessionId);
  });
}

export function approveResearchPlan(params: {
  sessionId: string;
  userId: string;
  updatedPlan?: ResearchPlan;
}): ResearchSession {
  const session = getResearchSession(params.sessionId, params.userId);
  if (!session) throw new Error('Research session not found.');
  if (session.status !== 'awaiting_approval' && session.status !== 'paused') {
    throw new Error(`Session cannot be approved from status "${session.status}".`);
  }

  const planToApprove = params.updatedPlan ?? session.plan;
  if (!planToApprove || planToApprove.subtopics.length === 0) {
    throw new Error('Approved research plan must include at least one subtopic.');
  }

  const checkpoint = session.checkpoint ?? createInitialCheckpoint(session.id, session.maxRetries);
  checkpoint.plan = planToApprove;
  checkpoint.currentStep = 'research_coordinator';
  saveSessionProjection({ sessionId: session.id, status: 'running', checkpoint });

  const resumePayload: HumanApprovalResumePayload = {
    action: 'approve',
    updatedPlan: planToApprove,
  };

  dispatchLangGraphResumeAsync({
    sessionId: session.id,
    userId: params.userId,
    input: new Command({ resume: resumePayload }),
  });

  return getResearchSession(session.id, params.userId)!;
}

/**
 * Handles plan rejection at the LangGraph `human_approval` interrupt.
 * - When `revise: true`, routes back to `planner` with user feedback and pauses again at `human_approval`.
 * - Otherwise terminates the workflow cleanly in `'rejected'` status.
 */
export async function rejectResearchPlan(params: {
  sessionId: string;
  userId: string;
  reason?: string;
  revise?: boolean;
}): Promise<ResearchSession> {
  const session = getResearchSession(params.sessionId, params.userId);
  if (!session) throw new Error('Research session not found.');
  if (session.status !== 'awaiting_approval') {
    throw new Error('Only plans awaiting approval can be rejected or revised.');
  }

  const resumePayload: HumanApprovalResumePayload = params.revise
    ? {
        action: 'revise',
        feedback: params.reason?.trim() || 'Refine subtopics and broaden source coverage.',
      }
    : {
        action: 'reject',
        reason: params.reason?.trim() || 'Plan rejected by researcher.',
      };

  await runGraphStreamAndSync({
    sessionId: session.id,
    userId: params.userId,
    input: new Command({ resume: resumePayload }),
  });

  return getResearchSession(session.id, params.userId)!;
}

export async function resumeResearchExecution(params: {
  sessionId: string;
  userId: string;
}): Promise<ResearchSession> {
  const session = getResearchSession(params.sessionId, params.userId);
  if (!session) throw new Error('Research session not found.');
  if (session.status !== 'paused' && session.status !== 'failed') {
    throw new Error(`Cannot resume session in status "${session.status}".`);
  }
  if (!session.plan) {
    throw new Error('No research plan checkpoint available to resume.');
  }

  const graph = buildWorkflowGraph();
  const config = makeThreadConfig(session.id, params.userId);
  const savedState = await graph.getState(config);

  const checkpoint = session.checkpoint ?? createInitialCheckpoint(session.id, session.maxRetries);
  saveSessionProjection({
    sessionId: session.id,
    status: 'running',
    checkpoint,
    errorMessage: null,
  });

  appendExecutionEvent({
    sessionId: session.id,
    eventType: 'execution_started',
    agentId: checkpoint.currentStep,
    message: 'Resuming LangGraph execution from durable SQLite checkpoint.',
  });

  // If the thread is paused at the human_approval interrupt, resume with approve;
  // otherwise pass `null` so LangGraph continues directly from the saved SQLite superstep.
  if (Array.isArray(savedState.next) && savedState.next.includes('human_approval')) {
    dispatchLangGraphResumeAsync({
      sessionId: session.id,
      userId: params.userId,
      input: new Command({
        resume: { action: 'approve', updatedPlan: session.plan } satisfies HumanApprovalResumePayload,
      }),
    });
  } else if (Array.isArray(savedState.next) && savedState.next.length > 0) {
    dispatchLangGraphResumeAsync({
      sessionId: session.id,
      userId: params.userId,
      input: null,
    });
  } else {
    // Recovery path for a failed/pre-migration session without pending LangGraph next nodes
    const settings = getUserSettings(params.userId);
    await graph.updateState(
      config,
      {
        sessionId: session.id,
        userId: params.userId,
        question: session.question,
        mode: session.mode,
        includeWeb: session.includeWeb,
        includeRag: session.includeRag,
        collectionIds: session.collectionIds,
        maxRetries: session.maxRetries,
        groundednessThreshold: settings.groundednessThreshold,
        reportTone: settings.reportTone,
        citationStyle: settings.citationStyle,
        plan: session.plan,
        sources: checkpoint.sources,
        claims: checkpoint.claims,
        contradictions: checkpoint.contradictions,
        topicSummaries: checkpoint.topicSummaries,
        retryCount: checkpoint.retryCount,
        status: 'running',
        currentStep: 'research_coordinator',
        completedAgents: checkpoint.completedAgents,
      },
      'human_approval'
    );
    dispatchLangGraphResumeAsync({
      sessionId: session.id,
      userId: params.userId,
      input: null,
    });
  }

  return getResearchSession(session.id, params.userId)!;
}

/**
 * Deletes both the research session row and its associated LangGraph SQLite thread checkpoints.
 */
export async function deleteResearchSessionAndThread(
  sessionId: string,
  userId: string
): Promise<boolean> {
  if (activeRuns.has(sessionId)) throw new Error('Pause or stop the active workflow before deleting it.');
  const db = getDb();
  const info = db
    .prepare(`DELETE FROM research_sessions WHERE id = ? AND user_id = ?`)
    .run(sessionId, userId);
  if (info.changes === 0) return false;
  await getSqliteCheckpointer().deleteThread(sessionId);
  return true;
}

/** Request a cooperative pause. The stream exits after the current graph step is checkpointed. */
export function pauseResearchExecution(params: { sessionId: string; userId: string }): ResearchSession {
  const session = getResearchSession(params.sessionId, params.userId);
  if (!session) throw new Error('Research session not found.');
  if (session.status !== 'running' || !activeRuns.has(session.id)) {
    throw new Error('Only an actively running workflow can be paused.');
  }
  pendingRunControls.set(session.id, 'pause');
  return session;
}

/** Request a cooperative stop, or stop an already paused workflow immediately. */
export function stopResearchExecution(params: { sessionId: string; userId: string }): ResearchSession {
  const session = getResearchSession(params.sessionId, params.userId);
  if (!session) throw new Error('Research session not found.');
  if (session.status === 'running' && activeRuns.has(session.id)) {
    pendingRunControls.set(session.id, 'stop');
    return session;
  }
  if (session.status === 'paused') {
    const checkpoint = session.checkpoint ?? createInitialCheckpoint(session.id, session.maxRetries);
    saveSessionProjection({ sessionId: session.id, status: 'stopped', checkpoint, completedAt: new Date().toISOString(), errorMessage: 'Execution stopped by user.' });
    appendExecutionEvent({ sessionId: session.id, eventType: 'execution_stopped', agentId: checkpoint.currentStep, message: 'Paused workflow stopped by user.' });
    return getResearchSession(session.id, params.userId)!;
  }
  throw new Error('Only a running or paused workflow can be stopped.');
}
