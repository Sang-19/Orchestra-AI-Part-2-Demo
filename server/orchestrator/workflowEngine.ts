import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { getDb } from '../db/database';
import {
  createInitialCheckpoint,
  evaluateAdaptiveRetryDecision,
  renderReportMarkdown,
  validateResearchInput,
} from './stateMachine';
import {
  runContradictionCheckerAgent,
  runEvidenceExtractionAgent,
  runFactCheckerAgent,
  runGroundednessCheckerAgent,
  runPlannerAgent,
  runQualityEvaluatorAgent,
  runSourceCredibilityAgent,
  runSubtopicResearcher,
  runSummarizerAgent,
  runWriterAgent,
} from './agents';
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

function appendExecutionEvent(params: {
  sessionId: string;
  eventType: ExecutionEvent['eventType'];
  agentId: AgentId | null;
  message: string;
  payload?: Record<string, unknown> | null;
}): ExecutionEvent {
  const db = getDb();
  const now = new Date().toISOString();
  const row = db
    .prepare(`SELECT COALESCE(MAX(seq), 0) as maxSeq FROM execution_events WHERE session_id = ?`)
    .get(params.sessionId) as { maxSeq: number };

  const evt: ExecutionEvent = {
    id: `evt-${crypto.randomUUID()}`,
    sessionId: params.sessionId,
    seq: row.maxSeq + 1,
    eventType: params.eventType,
    agentId: params.agentId,
    message: params.message,
    payload: params.payload ?? null,
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

function saveCheckpoint(params: {
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
        updated_at: string;
      }
    | undefined;

  if (!row) {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO user_settings (user_id, updated_at) VALUES (?, ?)`
    ).run(userId, now);
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
    plan: row.plan_json ? (JSON.parse(String(row.plan_json)) as ResearchPlan) : null,
    checkpoint: row.checkpoint_json
      ? (JSON.parse(String(row.checkpoint_json)) as WorkflowCheckpoint)
      : null,
    report: row.report_json ? (JSON.parse(String(row.report_json)) as ResearchSession['report']) : null,
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
  const checkpoint = createInitialCheckpoint(sessionId, maxRetries);

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
    JSON.stringify(checkpoint),
    now,
    now,
    now
  );

  appendExecutionEvent({
    sessionId,
    eventType: 'execution_started',
    agentId: 'input_validation',
    message: 'Input validated and research workflow initialized.',
  });

  checkpoint.completedAgents.push('input_validation');
  checkpoint.currentStep = 'planner';
  saveCheckpoint({ sessionId, status: 'planning', checkpoint });

  appendExecutionEvent({
    sessionId,
    eventType: 'agent_started',
    agentId: 'planner',
    message: 'Planner Agent decomposing research question into structured subtopics.',
  });

  try {
    const plan = await runPlannerAgent({
      question: params.question.trim(),
      mode,
      includeWeb,
      includeRag,
    });

    checkpoint.plan = plan;
    checkpoint.completedAgents.push('planner');
    checkpoint.currentStep = 'human_approval';
    saveCheckpoint({ sessionId, status: 'awaiting_approval', checkpoint });

    appendExecutionEvent({
      sessionId,
      eventType: 'agent_completed',
      agentId: 'planner',
      message: `Generated ${plan.subtopics.length}-subtopic research plan.`,
      payload: { subtopicCount: plan.subtopics.length },
    });

    appendExecutionEvent({
      sessionId,
      eventType: 'approval_required',
      agentId: 'human_approval',
      message: 'Workflow paused at Human Approval checkpoint. Review and approve the plan to execute.',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Planner Agent failed.';
    saveCheckpoint({
      sessionId,
      status: 'failed',
      checkpoint,
      completedAt: new Date().toISOString(),
      errorMessage: msg,
    });
    appendExecutionEvent({
      sessionId,
      eventType: 'execution_failed',
      agentId: 'planner',
      message: msg,
    });
  }

  return getResearchSession(sessionId, params.userId)!;
}

export function startWorkflowExecutionAsync(params: {
  sessionId: string;
  userId: string;
}): void {
  if (activeRuns.has(params.sessionId)) return;
  activeRuns.add(params.sessionId);

  void executeWorkflowFromCheckpoint(params.sessionId, params.userId).finally(() => {
    activeRuns.delete(params.sessionId);
  });
}

async function executeWorkflowFromCheckpoint(sessionId: string, userId: string): Promise<void> {
  const session = getResearchSession(sessionId, userId);
  if (!session || !session.checkpoint || !session.plan) return;

  const checkpoint = session.checkpoint;
  const settings = getUserSettings(userId);
  let extraQueries: string[] = [];

  try {
    while (true) {
      // 1. Research Coordinator & Parallel Researchers
      checkpoint.currentStep = 'research_coordinator';
      saveCheckpoint({ sessionId, status: 'running', checkpoint });
      appendExecutionEvent({
        sessionId,
        eventType: 'agent_started',
        agentId: 'research_coordinator',
        message: `Coordinating parallel research across ${session.plan.subtopics.length} subtopics (cycle ${checkpoint.retryCount + 1}).`,
      });

      checkpoint.currentStep = 'researcher';
      saveCheckpoint({ sessionId, status: 'running', checkpoint });
      appendExecutionEvent({
        sessionId,
        eventType: 'agent_started',
        agentId: 'researcher',
        message: 'Executing parallel web search and knowledge base retrieval.',
      });

      let citationOffset = checkpoint.sources.length + 1;
      const parallelResults = await Promise.all(
        session.plan.subtopics.map((subtopic, idx) =>
          runSubtopicResearcher({
            userId,
            objective: session.plan!.objective,
            subtopic,
            includeWeb: session.includeWeb,
            includeRag: session.includeRag,
            collectionIds: session.collectionIds,
            extraQueries: idx === 0 ? extraQueries : [],
            startingCitationNumber: citationOffset + idx * 10,
          })
        )
      );

      const newlyGathered = parallelResults.flatMap((r) => r.sources);
      const existingUrls = new Set(checkpoint.sources.map((s) => s.url));
      for (const src of newlyGathered) {
        if (!existingUrls.has(src.url)) {
          src.citationNumber = checkpoint.sources.length + 1;
          checkpoint.sources.push(src);
          existingUrls.add(src.url);
        }
      }

      if (!checkpoint.completedAgents.includes('research_coordinator')) {
        checkpoint.completedAgents.push('research_coordinator');
      }
      if (!checkpoint.completedAgents.includes('researcher')) {
        checkpoint.completedAgents.push('researcher');
      }
      saveCheckpoint({ sessionId, status: 'running', checkpoint });

      appendExecutionEvent({
        sessionId,
        eventType: 'evidence_discovered',
        agentId: 'researcher',
        message: `Collected ${checkpoint.sources.length} total sources across Knowledge Base and web.`,
        payload: { sourceCount: checkpoint.sources.length },
      });

      // 2. Evidence Extraction
      checkpoint.currentStep = 'evidence_extraction';
      saveCheckpoint({ sessionId, status: 'running', checkpoint });
      appendExecutionEvent({
        sessionId,
        eventType: 'agent_started',
        agentId: 'evidence_extraction',
        message: 'Extracting atomic factual claims and preserving supporting passages.',
      });

      checkpoint.claims = await runEvidenceExtractionAgent({
        objective: session.plan.objective,
        sources: checkpoint.sources,
      });
      if (!checkpoint.completedAgents.includes('evidence_extraction')) {
        checkpoint.completedAgents.push('evidence_extraction');
      }
      saveCheckpoint({ sessionId, status: 'running', checkpoint });

      appendExecutionEvent({
        sessionId,
        eventType: 'agent_completed',
        agentId: 'evidence_extraction',
        message: `Extracted ${checkpoint.claims.length} attributed claims.`,
        payload: { claimCount: checkpoint.claims.length },
      });

      // 3. Fact Checker
      checkpoint.currentStep = 'fact_checker';
      saveCheckpoint({ sessionId, status: 'running', checkpoint });
      appendExecutionEvent({
        sessionId,
        eventType: 'agent_started',
        agentId: 'fact_checker',
        message: 'Comparing claims against source passages and assigning calibrated confidence scores.',
      });

      checkpoint.claims = await runFactCheckerAgent({
        claims: checkpoint.claims,
        sources: checkpoint.sources,
      });
      if (!checkpoint.completedAgents.includes('fact_checker')) {
        checkpoint.completedAgents.push('fact_checker');
      }
      saveCheckpoint({ sessionId, status: 'running', checkpoint });

      appendExecutionEvent({
        sessionId,
        eventType: 'agent_completed',
        agentId: 'fact_checker',
        message: `Fact-checked ${checkpoint.claims.length} claims.`,
      });

      // 4. Source Credibility
      checkpoint.currentStep = 'source_credibility';
      saveCheckpoint({ sessionId, status: 'running', checkpoint });
      appendExecutionEvent({
        sessionId,
        eventType: 'agent_started',
        agentId: 'source_credibility',
        message: 'Grading source authority, primary vs. secondary status, and publication recency.',
      });

      checkpoint.sources = await runSourceCredibilityAgent(checkpoint.sources);
      if (!checkpoint.completedAgents.includes('source_credibility')) {
        checkpoint.completedAgents.push('source_credibility');
      }
      saveCheckpoint({ sessionId, status: 'running', checkpoint });

      appendExecutionEvent({
        sessionId,
        eventType: 'agent_completed',
        agentId: 'source_credibility',
        message: `Evaluated credibility for ${checkpoint.sources.length} sources.`,
      });

      // 5. Contradiction Checker
      checkpoint.currentStep = 'contradiction_checker';
      saveCheckpoint({ sessionId, status: 'running', checkpoint });
      appendExecutionEvent({
        sessionId,
        eventType: 'agent_started',
        agentId: 'contradiction_checker',
        message: 'Detecting and preserving conflicting claims across retrieved evidence.',
      });

      checkpoint.contradictions = await runContradictionCheckerAgent({
        claims: checkpoint.claims,
        sources: checkpoint.sources,
      });
      if (!checkpoint.completedAgents.includes('contradiction_checker')) {
        checkpoint.completedAgents.push('contradiction_checker');
      }
      saveCheckpoint({ sessionId, status: 'running', checkpoint });

      appendExecutionEvent({
        sessionId,
        eventType: 'agent_completed',
        agentId: 'contradiction_checker',
        message: `Identified and preserved ${checkpoint.contradictions.length} contradictions/tensions.`,
      });

      // 6. Summarizer
      checkpoint.currentStep = 'summarizer';
      saveCheckpoint({ sessionId, status: 'running', checkpoint });
      appendExecutionEvent({
        sessionId,
        eventType: 'agent_started',
        agentId: 'summarizer',
        message: 'Synthesizing topic-wise findings and knowledge gaps.',
      });

      checkpoint.topicSummaries = await runSummarizerAgent({
        plan: session.plan,
        claims: checkpoint.claims,
        sources: checkpoint.sources,
        contradictions: checkpoint.contradictions,
      });
      if (!checkpoint.completedAgents.includes('summarizer')) {
        checkpoint.completedAgents.push('summarizer');
      }
      saveCheckpoint({ sessionId, status: 'running', checkpoint });

      appendExecutionEvent({
        sessionId,
        eventType: 'agent_completed',
        agentId: 'summarizer',
        message: `Structured ${checkpoint.topicSummaries.length} topic syntheses.`,
      });

      // 7. Writer
      checkpoint.currentStep = 'writer';
      saveCheckpoint({ sessionId, status: 'running', checkpoint });
      appendExecutionEvent({
        sessionId,
        eventType: 'agent_started',
        agentId: 'writer',
        message: 'Drafting multi-section cited research report.',
      });

      checkpoint.report = await runWriterAgent({
        question: session.question,
        plan: session.plan,
        topicSummaries: checkpoint.topicSummaries,
        claims: checkpoint.claims,
        contradictions: checkpoint.contradictions,
        sources: checkpoint.sources,
        reportTone: settings.reportTone,
        citationStyle: settings.citationStyle,
      });
      if (!checkpoint.completedAgents.includes('writer')) {
        checkpoint.completedAgents.push('writer');
      }
      saveCheckpoint({ sessionId, status: 'running', checkpoint });

      appendExecutionEvent({
        sessionId,
        eventType: 'agent_completed',
        agentId: 'writer',
        message: 'Completed full research report draft with inline citations.',
      });

      // 8. Groundedness Checker
      checkpoint.currentStep = 'groundedness_checker';
      saveCheckpoint({ sessionId, status: 'running', checkpoint });
      appendExecutionEvent({
        sessionId,
        eventType: 'agent_started',
        agentId: 'groundedness_checker',
        message: 'Auditing report statements and citations against verified claims.',
      });

      checkpoint.groundedness = await runGroundednessCheckerAgent({
        report: checkpoint.report,
        claims: checkpoint.claims,
        sources: checkpoint.sources,
        threshold: settings.groundednessThreshold,
      });
      // Refresh markdown banner with groundedness verification status
      checkpoint.report.markdownContent = renderReportMarkdown({
        report: checkpoint.report,
        sources: checkpoint.sources,
        contradictions: checkpoint.contradictions,
        groundedness: checkpoint.groundedness,
      });

      if (!checkpoint.completedAgents.includes('groundedness_checker')) {
        checkpoint.completedAgents.push('groundedness_checker');
      }
      saveCheckpoint({ sessionId, status: 'running', checkpoint });

      appendExecutionEvent({
        sessionId,
        eventType: 'validation_result',
        agentId: 'groundedness_checker',
        message: checkpoint.groundedness.summary,
        payload: {
          passed: checkpoint.groundedness.passed,
          score: checkpoint.groundedness.score,
        },
      });

      // 9. Research Quality Evaluator & Adaptive Retry Decision
      checkpoint.currentStep = 'quality_evaluator';
      saveCheckpoint({ sessionId, status: 'running', checkpoint });
      appendExecutionEvent({
        sessionId,
        eventType: 'agent_started',
        agentId: 'quality_evaluator',
        message: 'Evaluating overall completeness and deciding whether adaptive retry is required.',
      });

      checkpoint.quality = await runQualityEvaluatorAgent({
        question: session.question,
        plan: session.plan,
        claims: checkpoint.claims,
        groundedness: checkpoint.groundedness,
      });
      if (!checkpoint.completedAgents.includes('quality_evaluator')) {
        checkpoint.completedAgents.push('quality_evaluator');
      }

      const decision = evaluateAdaptiveRetryDecision({
        groundedness: checkpoint.groundedness,
        quality: checkpoint.quality,
        retryCount: checkpoint.retryCount,
        maxRetries: checkpoint.maxRetries,
        groundednessThreshold: settings.groundednessThreshold,
      });

      if (decision.shouldRetry) {
        checkpoint.retryCount += 1;
        extraQueries = checkpoint.quality.recommendedQueries.slice(0, 2);
        saveCheckpoint({ sessionId, status: 'running', checkpoint });

        appendExecutionEvent({
          sessionId,
          eventType: 'research_retry',
          agentId: 'quality_evaluator',
          message: decision.reason,
          payload: {
            retryCount: checkpoint.retryCount,
            recommendedQueries: extraQueries,
          },
        });
        continue;
      }

      const completedAt = new Date().toISOString();
      saveCheckpoint({
        sessionId,
        status: decision.finalStatus,
        checkpoint,
        completedAt,
      });

      appendExecutionEvent({
        sessionId,
        eventType: 'execution_completed',
        agentId: 'quality_evaluator',
        message: decision.reason,
        payload: {
          status: decision.finalStatus,
          groundednessPassed: checkpoint.groundedness.passed,
          groundednessScore: checkpoint.groundedness.score,
        },
      });
      break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected workflow execution error.';
    saveCheckpoint({
      sessionId,
      status: 'failed',
      checkpoint,
      completedAt: new Date().toISOString(),
      errorMessage: message,
    });
    appendExecutionEvent({
      sessionId,
      eventType: 'execution_failed',
      agentId: checkpoint.currentStep,
      message,
    });
  }
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

  const checkpoint = session.checkpoint ?? createInitialCheckpoint(session.id, session.maxRetries);
  if (params.updatedPlan) {
    checkpoint.plan = params.updatedPlan;
  }
  if (!checkpoint.completedAgents.includes('human_approval')) {
    checkpoint.completedAgents.push('human_approval');
  }
  checkpoint.currentStep = 'research_coordinator';
  saveCheckpoint({ sessionId: session.id, status: 'running', checkpoint });

  appendExecutionEvent({
    sessionId: session.id,
    eventType: 'agent_completed',
    agentId: 'human_approval',
    message: 'Research plan approved. Dispatching research agents.',
  });

  startWorkflowExecutionAsync({ sessionId: session.id, userId: params.userId });
  return getResearchSession(session.id, params.userId)!;
}

export function rejectResearchPlan(params: {
  sessionId: string;
  userId: string;
  reason?: string;
}): ResearchSession {
  const session = getResearchSession(params.sessionId, params.userId);
  if (!session) throw new Error('Research session not found.');
  if (session.status !== 'awaiting_approval') {
    throw new Error('Only plans awaiting approval can be rejected.');
  }

  const checkpoint = session.checkpoint ?? createInitialCheckpoint(session.id, session.maxRetries);
  saveCheckpoint({
    sessionId: session.id,
    status: 'rejected',
    checkpoint,
    completedAt: new Date().toISOString(),
    errorMessage: params.reason || 'Plan rejected by researcher.',
  });

  appendExecutionEvent({
    sessionId: session.id,
    eventType: 'execution_paused',
    agentId: 'human_approval',
    message: params.reason
      ? `Plan rejected: ${params.reason}`
      : 'Plan rejected by researcher.',
  });

  return getResearchSession(session.id, params.userId)!;
}

export function resumeResearchExecution(params: {
  sessionId: string;
  userId: string;
}): ResearchSession {
  const session = getResearchSession(params.sessionId, params.userId);
  if (!session) throw new Error('Research session not found.');
  if (session.status !== 'paused' && session.status !== 'failed') {
    throw new Error(`Cannot resume session in status "${session.status}".`);
  }
  if (!session.plan) {
    throw new Error('No research plan checkpoint available to resume.');
  }

  const checkpoint = session.checkpoint ?? createInitialCheckpoint(session.id, session.maxRetries);
  saveCheckpoint({ sessionId: session.id, status: 'running', checkpoint, errorMessage: null });

  appendExecutionEvent({
    sessionId: session.id,
    eventType: 'execution_started',
    agentId: checkpoint.currentStep,
    message: 'Resuming execution from durable SQLite checkpoint.',
  });

  startWorkflowExecutionAsync({ sessionId: session.id, userId: params.userId });
  return getResearchSession(session.id, params.userId)!;
}
