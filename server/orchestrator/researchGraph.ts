import {
  Command,
  END,
  START,
  Send,
  StateGraph,
  interrupt,
} from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
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
import {
  OrchestraStateAnnotation,
  type HumanApprovalResumePayload,
  type OrchestraGraphState,
  createExecutionCycle,
  type OrchestraGraphUpdate,
  type QualityRouteAction,
  type SubtopicResearchTaskInput,
} from './graphState';
import { getSqliteCheckpointer } from './sqliteCheckpointer';
import {
  evaluateAdaptiveRetryDecision,
  validateResearchInput,
} from './stateMachine';
import { formatResearchReportTool } from '../tools/researchTools';
import type {
  AgentId,
  ExecutionEvent,
  PlanSubtopic,
  ResearchStatus,
} from '../../src/types/research';

export interface GraphEventPayload {
  sessionId: string;
  eventType: ExecutionEvent['eventType'];
  agentId: AgentId | null;
  message: string;
  payload?: Record<string, unknown> | null;
}

export interface GraphAgentDependencies {
  planner: typeof runPlannerAgent;
  subtopicResearcher: typeof runSubtopicResearcher;
  evidenceExtractor: typeof runEvidenceExtractionAgent;
  factChecker: typeof runFactCheckerAgent;
  sourceCredibility: typeof runSourceCredibilityAgent;
  contradictionChecker: typeof runContradictionCheckerAgent;
  summarizer: typeof runSummarizerAgent;
  writer: typeof runWriterAgent;
  groundednessChecker: typeof runGroundednessCheckerAgent;
  qualityEvaluator: typeof runQualityEvaluatorAgent;
}

export const defaultGraphAgentDependencies: GraphAgentDependencies = {
  planner: runPlannerAgent,
  subtopicResearcher: runSubtopicResearcher,
  evidenceExtractor: runEvidenceExtractionAgent,
  factChecker: runFactCheckerAgent,
  sourceCredibility: runSourceCredibilityAgent,
  contradictionChecker: runContradictionCheckerAgent,
  summarizer: runSummarizerAgent,
  writer: runWriterAgent,
  groundednessChecker: runGroundednessCheckerAgent,
  qualityEvaluator: runQualityEvaluatorAgent,
};

export interface CreateResearchGraphOptions {
  checkpointer?: BaseCheckpointSaver;
  agents?: Partial<GraphAgentDependencies>;
  maxParallelResearch?: number;
  maxNodeAttempts?: number;
  nodeRetryDelayMs?: number;
  onEvent?: (event: GraphEventPayload) => void;
  onStateTransition?: (state: OrchestraGraphState, statusOverride?: ResearchStatus) => void;
}

/**
 * Lightweight concurrency semaphore to bound parallel LangGraph Send() worker execution.
 */
class ConcurrencySemaphore {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly maxConcurrency: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrency) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

async function withNodeRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  baseDelayMs: number
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts) break;
      if (baseDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt));
      }
    }
  }
  throw lastError;
}

/**
 * Deduplicates subtopics by normalized ID or title to prevent duplicate parallel tasks.
 */
export function deduplicateSubtopics(subtopics: PlanSubtopic[]): PlanSubtopic[] {
  const seenIds = new Set<string>();
  const seenTitles = new Set<string>();
  const result: PlanSubtopic[] = [];

  for (const st of subtopics) {
    const idKey = st.id.trim().toLowerCase();
    const titleKey = st.title.trim().toLowerCase();
    if (!titleKey || seenIds.has(idKey) || seenTitles.has(titleKey)) continue;
    seenIds.add(idKey);
    seenTitles.add(titleKey);
    result.push(st);
  }
  return result;
}

/**
 * Pure conditional routing decision used by the Quality Evaluator node.
 * Strictly bounded by `maxRetries` so the LangGraph can never enter an infinite loop.
 */
export function decidePostQualityRoute(state: OrchestraGraphState): {
  action: QualityRouteAction;
  finalStatus: ResearchStatus;
  reason: string;
  extraQueries: string[];
  rewriteInstructions: string[];
} {
  const groundedness = state.groundedness;
  const quality = state.quality;

  if (!groundedness || !quality) {
    return {
      action: 'complete',
      finalStatus: 'completed_with_warnings',
      reason: 'Missing validation output; concluding with warnings.',
      extraQueries: [],
      rewriteInstructions: [],
    };
  }

  const baseDecision = evaluateAdaptiveRetryDecision({
    groundedness,
    quality,
    retryCount: state.retryCount,
    maxRetries: state.maxRetries,
    groundednessThreshold: state.groundednessThreshold,
  });

  if (!baseDecision.shouldRetry) {
    return {
      action: 'complete',
      finalStatus: baseDecision.finalStatus,
      reason: baseDecision.reason,
      extraQueries: [],
      rewriteInstructions: [],
    };
  }

  // Case 1: Evidence coverage and completeness are already adequate, but the report itself
  // has unsupported statements or citation errors -> route directly to Writer to rewrite.
  const hasReportGroundingIssues =
    !groundedness.passed &&
    (groundedness.unsupportedStatements.length > 0 || groundedness.citationIssues.length > 0);
  const evidenceCoverageAdequate =
    state.sources.length > 0 &&
    state.claims.length > 0 &&
    quality.completenessScore >= 0.72 &&
    !quality.shouldRetry;

  if (hasReportGroundingIssues && evidenceCoverageAdequate) {
    const rewriteInstructions = [
      ...groundedness.unsupportedStatements.map((s) => `Remove or substantiate unsupported claim: ${s}`),
      ...groundedness.citationIssues.map((c) => `Fix citation issue: ${c}`),
    ];
    return {
      action: 'rewrite_report',
      finalStatus: 'running',
      reason: `Routing to Writer Agent (retry ${state.retryCount + 1}/${state.maxRetries}) to rewrite unsupported statements and fix citation issues.`,
      extraQueries: [],
      rewriteInstructions,
    };
  }

  // Case 2: High-severity unresolved contradictions have not yet been rechecked while
  // evidence exists -> route back to Contradiction Checker to re-verify conflicts.
  const hasHighUnresolvedContradictions = state.contradictions.some(
    (c) => c.severity === 'high' && c.resolutionStatus === 'unresolved'
  );
  if (
    hasHighUnresolvedContradictions &&
    !state.contradictionRechecked &&
    state.claims.length >= 2 &&
    quality.completenessScore >= 0.65
  ) {
    return {
      action: 'recheck_contradictions',
      finalStatus: 'running',
      reason: `Routing to Contradiction Checker (retry ${state.retryCount + 1}/${state.maxRetries}) to re-evaluate high-severity unresolved conflicts.`,
      extraQueries: [],
      rewriteInstructions: [],
    };
  }

  // Case 3: Insufficient evidence or incomplete subtopic coverage -> return to parallel research.
  return {
    action: 'retry_research',
    finalStatus: 'running',
    reason: baseDecision.reason,
    extraQueries: quality.recommendedQueries.slice(0, 2),
    rewriteInstructions: [],
  };
}

/**
 * Builds and compiles the central Orchestra AI LangGraph `StateGraph`.
 *
 * Workflow:
 * START -> input_validation -> planner -> human_approval (interrupt)
 *   --[revise]--> planner
 *   --[reject]--> END
 *   --[approve]--> research_coordinator
 *     --[Send parallel]--> researcher_worker (bounded concurrency)
 *     --> evidence_extraction -> fact_checker -> source_credibility
 *     --> contradiction_checker -> summarizer -> writer
 *     --> groundedness_checker -> quality_evaluator
 *       --[retry_research]--> research_coordinator
 *       --[recheck_contradictions]--> contradiction_checker
 *       --[rewrite_report]--> writer
 *       --[complete]--> END
 */
export function createOrchestraResearchGraph(options: CreateResearchGraphOptions = {}) {
  const agents: GraphAgentDependencies = {
    ...defaultGraphAgentDependencies,
    ...(options.agents ?? {}),
  };
  const checkpointer = options.checkpointer ?? getSqliteCheckpointer();
  const maxParallel = Math.max(1, options.maxParallelResearch ?? 3);
  const maxNodeAttempts = Math.max(1, options.maxNodeAttempts ?? 2);
  const nodeRetryDelayMs = options.nodeRetryDelayMs ?? 150;
  const semaphore = new ConcurrencySemaphore(maxParallel);

  const emit = (evt: GraphEventPayload) => {
    options.onEvent?.(evt);
  };

  // 1. Input Validation Node
  const inputValidationNode = async (
    state: OrchestraGraphState
  ): Promise<OrchestraGraphUpdate> => {
    const validation = validateResearchInput(state.question);
    if (!validation.valid) {
      throw new Error(validation.reason || 'Invalid research question.');
    }
    if (!state.includeWeb && !state.includeRag) {
      throw new Error('Select at least one knowledge source (Web Search or Knowledge Base).');
    }

    emit({
      sessionId: state.sessionId,
      eventType: 'execution_started',
      agentId: 'input_validation',
      message: 'Input validated and LangGraph research workflow initialized.',
    });

    return {
      status: 'planning',
      currentStep: 'planner',
      completedAgents: ['input_validation'],
      executionCycle: createExecutionCycle(1, 'planner', 'planning', ['input_validation']),
    };
  };

  // 2. Planner Agent Node
  const plannerNode = async (
    state: OrchestraGraphState
  ): Promise<OrchestraGraphUpdate> => {
    emit({
      sessionId: state.sessionId,
      eventType: 'agent_started',
      agentId: 'planner',
      payload: { timeoutMs: Math.max(10_000, Number(process.env.AGENT_REQUEST_TIMEOUT_MS) || 90_000) },
      message: state.plannerFeedback
        ? `Planner Agent revising research plan with feedback: "${state.plannerFeedback}"`
        : 'Planner Agent decomposing research question into structured subtopics.',
    });

    const plan = await withNodeRetry(
      () =>
        agents.planner({
          question: state.question.trim(),
          mode: state.mode,
          includeWeb: state.includeWeb,
          includeRag: state.includeRag,
          feedback: state.plannerFeedback,
        }),
      maxNodeAttempts,
      nodeRetryDelayMs
    );

    emit({
      sessionId: state.sessionId,
      eventType: 'agent_completed',
      agentId: 'planner',
      message: `Generated ${plan.subtopics.length}-subtopic research plan.`,
      payload: { subtopicCount: plan.subtopics.length, revised: Boolean(state.plannerFeedback) },
    });

    emit({
      sessionId: state.sessionId,
      eventType: 'approval_required',
      agentId: 'human_approval',
      message:
        'Workflow paused at LangGraph Human Approval interrupt. Review, edit, revise, or approve the plan.',
    });

    return {
      plan,
      status: 'awaiting_approval',
      currentStep: 'human_approval',
      approvalDecision: 'pending',
      completedAgents: ['planner'],
      executionCycle: createExecutionCycle(state.retryCount + 1, 'human_approval', 'awaiting_approval', ['input_validation', 'planner']),
    };
  };

  // 3. Human Approval Node (Native LangGraph interrupt + Command routing)
  const humanApprovalNode = async (state: OrchestraGraphState) => {
    const decision = interrupt({
      type: 'human_plan_approval',
      sessionId: state.sessionId,
      question: state.question,
      plan: state.plan,
    }) as HumanApprovalResumePayload | undefined;

    if (!decision || typeof decision !== 'object') {
      throw new Error('Invalid human approval resume payload.');
    }

    if (decision.action === 'revise') {
      const feedback = (decision.feedback || decision.reason || '').trim();
      emit({
        sessionId: state.sessionId,
        eventType: 'agent_progress',
        agentId: 'human_approval',
        message: feedback
          ? `Plan revision requested; returning to Planner Agent with feedback: "${feedback}"`
          : 'Plan revision requested; returning to Planner Agent.',
      });

      return new Command({
        goto: 'planner',
        update: {
          plannerFeedback: feedback || 'Refine subtopics and search queries.',
          approvalDecision: 'revise',
          status: 'planning',
          currentStep: 'planner',
        },
      });
    }

    if (decision.action === 'reject') {
      const reason = (decision.reason || decision.feedback || 'Plan rejected by researcher.').trim();
      emit({
        sessionId: state.sessionId,
        eventType: 'execution_paused',
        agentId: 'human_approval',
        message: `Plan rejected: ${reason}`,
      });

      return new Command({
        goto: END,
        update: {
          approvalDecision: 'rejected',
          status: 'rejected',
          rejectionReason: reason,
          errorMessage: reason,
          currentStep: 'human_approval',
        },
      });
    }

    const approvedPlan = decision.updatedPlan ?? state.plan;
    if (!approvedPlan || approvedPlan.subtopics.length === 0) {
      throw new Error('Cannot approve an empty research plan without subtopics.');
    }

    emit({
      sessionId: state.sessionId,
      eventType: 'agent_completed',
      agentId: 'human_approval',
      message: 'Research plan approved. Resuming LangGraph workflow and dispatching parallel researchers.',
    });

    return new Command({
      goto: 'research_coordinator',
      update: {
        plan: approvedPlan,
        approvalDecision: 'approved',
        plannerFeedback: null,
        status: 'running',
        currentStep: 'research_coordinator',
        completedAgents: ['human_approval'],
        executionCycle: createExecutionCycle(state.retryCount + 1, 'research_coordinator', 'running', ['input_validation', 'planner', 'human_approval']),
      },
    });
  };

  // 4. Research Coordinator Node (prepares parallel Send fan-out)
  const researchCoordinatorNode = async (
    state: OrchestraGraphState
  ): Promise<OrchestraGraphUpdate> => {
    const subtopics = deduplicateSubtopics(state.plan?.subtopics ?? []);

    emit({
      sessionId: state.sessionId,
      eventType: 'agent_started',
      agentId: 'research_coordinator',
      message: `Coordinating parallel research across ${subtopics.length} subtopics (cycle ${state.retryCount + 1}).`,
      payload: { subtopicCount: subtopics.length, cycle: state.retryCount + 1, timeoutMs: Math.max(10_000, Number(process.env.AGENT_REQUEST_TIMEOUT_MS) || 90_000) },
    });

    emit({
      sessionId: state.sessionId,
      eventType: 'agent_started',
      agentId: 'researcher',
      payload: { timeoutMs: Math.max(10_000, Number(process.env.AGENT_REQUEST_TIMEOUT_MS) || 90_000) },
      message: 'Dispatching concurrent LangGraph Send() researcher branches.',
    });

    return {
      status: 'running',
      currentStep: 'researcher',
      completedAgents: ['research_coordinator'],
      executionCycle: createExecutionCycle(state.retryCount + 1, 'researcher', 'running', [...(state.executionCycle?.completedAgents ?? state.completedAgents), 'research_coordinator']),
    };
  };

  // Conditional edge: fan-out via LangGraph Send()
  const fanOutParallelResearchers = (state: OrchestraGraphState) => {
    const plan = state.plan;
    const uniqueSubtopics = deduplicateSubtopics(plan?.subtopics ?? []);
    if (!plan || uniqueSubtopics.length === 0) {
      return 'evidence_extraction';
    }

    const citationBase = state.sources.length + 1;
    return uniqueSubtopics.map(
      (subtopic, idx) =>
        new Send('researcher_worker', {
          sessionId: state.sessionId,
          userId: state.userId,
          objective: plan.objective,
          subtopic,
          includeWeb: state.includeWeb,
          includeRag: state.includeRag,
          collectionIds: state.collectionIds,
          extraQueries: idx === 0 ? state.extraQueries : [],
          startingCitationNumber: citationBase + idx * 10,
        } satisfies SubtopicResearchTaskInput)
    );
  };

  // 5. Parallel Researcher Worker Node (invoked per subtopic via Send)
  const researcherWorkerNode = async (
    task: SubtopicResearchTaskInput
  ): Promise<OrchestraGraphUpdate> => {
    return semaphore.run(async () => {
      try {
        const result = await withNodeRetry(
          () =>
            agents.subtopicResearcher({
              userId: task.userId,
              objective: task.objective,
              subtopic: task.subtopic,
              includeWeb: task.includeWeb,
              includeRag: task.includeRag,
              collectionIds: task.collectionIds,
              extraQueries: task.extraQueries,
              startingCitationNumber: task.startingCitationNumber,
            }),
          maxNodeAttempts,
          nodeRetryDelayMs
        );

        emit({
          sessionId: task.sessionId,
          eventType: 'evidence_discovered',
          agentId: 'researcher',
          message: `Subtopic "${task.subtopic.title}" retrieved ${result.sources.length} sources.`,
          payload: {
            subtopicId: task.subtopic.id,
            sourceCount: result.sources.length,
          },
        });

        return {
          sources: result.sources,
          researchGaps: result.gaps,
        };
      } catch (err) {
        // Isolate individual branch failures so sibling parallel subtopics complete safely
        const errMsg = `Subtopic "${task.subtopic.title}" failed: ${
          err instanceof Error ? err.message : 'unknown error'
        }`;
        emit({
          sessionId: task.sessionId,
          eventType: 'agent_progress',
          agentId: 'researcher',
          message: errMsg,
          payload: { subtopicId: task.subtopic.id, failed: true },
        });
        return {
          sources: [],
          researchGaps: [errMsg],
          completedAgents: ['researcher'],
        };
      }
    });
  };

  // 6. Evidence Extraction Node runs only after every parallel researcher_worker branch
  // has joined. Emit an explicit researcher completion event here (not per worker), so
  // the UI cannot mark the parent stage complete while sibling branches are still running.
  const evidenceExtractionNode = async (
    state: OrchestraGraphState
  ): Promise<OrchestraGraphUpdate> => {
    const failedResearchBranches = state.researchGaps.filter((gap) =>
      /^Subtopic ".+" failed:/.test(gap)
    );
    const plannedSubtopics = deduplicateSubtopics(state.plan?.subtopics ?? []);

    emit({
      sessionId: state.sessionId,
      eventType: 'agent_completed',
      agentId: 'researcher',
      message: failedResearchBranches.length > 0
        ? `Research fan-out finished with ${failedResearchBranches.length} failed subtopic branch(es); ${state.sources.length} sources were collected.`
        : `All ${plannedSubtopics.length} parallel research branches completed; ${state.sources.length} sources were collected.`,
      payload: {
        subtopicCount: plannedSubtopics.length,
        sourceCount: state.sources.length,
        failedBranches: failedResearchBranches.length,
        partialFailure: failedResearchBranches.length > 0,
      },
    });

    emit({
      sessionId: state.sessionId,
      eventType: 'agent_started',
      agentId: 'evidence_extraction';
      payload: { timeoutMs: Math.max(10_000, Number(process.env.AGENT_REQUEST_TIMEOUT_MS) || 90_000) },
      message: `Extracting atomic factual claims from ${state.sources.length} aggregated sources.`,
    });

    const claims = await withNodeRetry(
      () =>
        agents.evidenceExtractor({
          objective: state.plan?.objective ?? state.question,
          sources: state.sources,
        }),
      maxNodeAttempts,
      nodeRetryDelayMs
    );

    emit({
      sessionId: state.sessionId,
      eventType: 'agent_completed',
      agentId: 'evidence_extraction',
      message: `Extracted ${claims.length} attributed claims.`,
      payload: { claimCount: claims.length, sourceCount: state.sources.length },
    });

    return {
      claims,
      currentStep: 'fact_checker',
      completedAgents: ['evidence_extraction'],
    };
  };

  // 7. Fact Checker Node
  const factCheckerNode = async (
    state: OrchestraGraphState
  ): Promise<OrchestraGraphUpdate> => {
    emit({
      sessionId: state.sessionId,
      eventType: 'agent_started',
      agentId: 'fact_checker',
      payload: { timeoutMs: Math.max(10_000, Number(process.env.AGENT_REQUEST_TIMEOUT_MS) || 90_000) },
      message: 'Comparing claims against source passages and assigning calibrated confidence scores.',
    });

    const claims = await withNodeRetry(
      () =>
        agents.factChecker({
          claims: state.claims,
          sources: state.sources,
        }),
      maxNodeAttempts,
      nodeRetryDelayMs
    );

    emit({
      sessionId: state.sessionId,
      eventType: 'agent_completed',
      agentId: 'fact_checker',
      message: `Fact-checked ${claims.length} claims.`,
    });

    return {
      claims,
      currentStep: 'source_credibility',
      completedAgents: ['fact_checker'],
    };
  };

  // 8. Source Credibility Node
  const sourceCredibilityNode = async (
    state: OrchestraGraphState
  ): Promise<OrchestraGraphUpdate> => {
    emit({
      sessionId: state.sessionId,
      eventType: 'agent_started',
      agentId: 'source_credibility',
      payload: { timeoutMs: Math.max(10_000, Number(process.env.AGENT_REQUEST_TIMEOUT_MS) || 90_000) },
      message: 'Grading source authority, primary vs. secondary status, and publication recency.',
    });

    const gradedSources = await withNodeRetry(
      () => agents.sourceCredibility(state.sources),
      maxNodeAttempts,
      nodeRetryDelayMs
    );

    emit({
      sessionId: state.sessionId,
      eventType: 'agent_completed',
      agentId: 'source_credibility',
      message: `Evaluated credibility for ${gradedSources.length} sources.`,
    });

    return {
      sources: gradedSources,
      currentStep: 'contradiction_checker',
      completedAgents: ['source_credibility'],
    };
  };

  // 9. Contradiction Checker Node
  const contradictionCheckerNode = async (
    state: OrchestraGraphState
  ): Promise<OrchestraGraphUpdate> => {
    emit({
      sessionId: state.sessionId,
      eventType: 'agent_started',
      agentId: 'contradiction_checker',
      payload: { timeoutMs: Math.max(10_000, Number(process.env.AGENT_REQUEST_TIMEOUT_MS) || 90_000) },
      message: state.contradictionRechecked
        ? 'Re-checking conflicting claims across retrieved evidence.'
        : 'Detecting and preserving conflicting claims across retrieved evidence.',
    });

    const contradictions = await withNodeRetry(
      () =>
        agents.contradictionChecker({
          claims: state.claims,
          sources: state.sources,
        }),
      maxNodeAttempts,
      nodeRetryDelayMs
    );

    emit({
      sessionId: state.sessionId,
      eventType: 'agent_completed',
      agentId: 'contradiction_checker',
      message: `Identified and preserved ${contradictions.length} contradictions/tensions.`,
    });

    return {
      contradictions,
      currentStep: 'summarizer',
      completedAgents: ['contradiction_checker'],
    };
  };

  // 10. Summarizer Node
  const summarizerNode = async (
    state: OrchestraGraphState
  ): Promise<OrchestraGraphUpdate> => {
    if (!state.plan) {
      throw new Error('Summarizer requires a valid research plan.');
    }

    emit({
      sessionId: state.sessionId,
      eventType: 'agent_started',
      agentId: 'summarizer',
      payload: { timeoutMs: Math.max(10_000, Number(process.env.AGENT_REQUEST_TIMEOUT_MS) || 90_000) },
      message: 'Synthesizing topic-wise findings and knowledge gaps.',
    });

    const topicSummaries = await withNodeRetry(
      () =>
        agents.summarizer({
          plan: state.plan!,
          claims: state.claims,
          sources: state.sources,
          contradictions: state.contradictions,
        }),
      maxNodeAttempts,
      nodeRetryDelayMs
    );

    emit({
      sessionId: state.sessionId,
      eventType: 'agent_completed',
      agentId: 'summarizer',
      message: `Structured ${topicSummaries.length} topic syntheses.`,
    });

    return {
      topicSummaries,
      currentStep: 'writer',
      completedAgents: ['summarizer'],
    };
  };

  // 11. Writer Node
  const writerNode = async (
    state: OrchestraGraphState
  ): Promise<OrchestraGraphUpdate> => {
    if (!state.plan) {
      throw new Error('Writer requires a valid research plan.');
    }

    emit({
      sessionId: state.sessionId,
      eventType: 'agent_started',
      agentId: 'writer',
      payload: { timeoutMs: Math.max(10_000, Number(process.env.AGENT_REQUEST_TIMEOUT_MS) || 90_000) },
      message:
        state.rewriteInstructions.length > 0
          ? 'Rewriting unsupported report sections and repairing citation references.'
          : 'Drafting multi-section cited research report.',
    });

    const report = await withNodeRetry(
      () =>
        agents.writer({
          question: state.question,
          plan: state.plan!,
          topicSummaries: state.topicSummaries,
          claims: state.claims,
          contradictions: state.contradictions,
          sources: state.sources,
          reportTone: state.reportTone,
          citationStyle: state.citationStyle,
          rewriteInstructions: state.rewriteInstructions,
        }),
      maxNodeAttempts,
      nodeRetryDelayMs
    );

    emit({
      sessionId: state.sessionId,
      eventType: 'agent_completed',
      agentId: 'writer',
      message: 'Completed full research report draft with inline citations.',
    });

    return {
      report,
      rewriteInstructions: [],
      currentStep: 'groundedness_checker',
      completedAgents: ['writer'],
    };
  };

  // 12. Groundedness Checker Node
  const groundednessCheckerNode = async (
    state: OrchestraGraphState
  ) => {
    if (!state.report) {
      throw new Error('Groundedness Checker requires a generated report.');
    }

    emit({
      sessionId: state.sessionId,
      eventType: 'agent_started',
      agentId: 'groundedness_checker',
      payload: { timeoutMs: Math.max(10_000, Number(process.env.AGENT_REQUEST_TIMEOUT_MS) || 90_000) },
      message: 'Auditing report statements and citations against verified claims.',
    });

    // The agent applies one shared wall-clock budget across its complete model-fallback chain.
    // Do not wrap it in the generic node retry: repeating a timed-out audit multiplies latency.
    const groundedness = await agents.groundednessChecker({
      report: state.report!,
      claims: state.claims,
      sources: state.sources,
      threshold: state.groundednessThreshold,
    });

    const updatedReport = {
      ...state.report,
      markdownContent: formatResearchReportTool({
        report: state.report,
        sources: state.sources,
        contradictions: state.contradictions,
        groundedness,
      }),
    };

    emit({
      sessionId: state.sessionId,
      eventType: 'validation_result',
      agentId: 'groundedness_checker',
      message: groundedness.summary,
      payload: {
        passed: groundedness.passed,
        score: groundedness.score,
        validationStatus: groundedness.validationStatus ?? 'complete',
      },
    });

    if (groundedness.validationStatus === 'incomplete') {
      emit({
        sessionId: state.sessionId,
        eventType: 'agent_progress',
        agentId: 'groundedness_checker',
        message: 'Groundedness audit did not finish; manual review is required.',
        payload: { failed: true, validationStatus: 'incomplete' },
      });
      emit({
        sessionId: state.sessionId,
        eventType: 'execution_completed',
        agentId: 'groundedness_checker',
        message: 'Research report saved with warnings because the AI groundedness audit timed out. Manual review is required.',
        payload: { status: 'completed_with_warnings', groundednessPassed: false, validationStatus: 'incomplete' },
      });
      return new Command({
        goto: END,
        update: {
          report: updatedReport,
          groundedness,
          status: 'completed_with_warnings',
          currentStep: 'groundedness_checker',
          // The audit timed out, so this stage must not be recorded as completed.
        },
      });
    }

    emit({
      sessionId: state.sessionId,
      eventType: 'agent_completed',
      agentId: 'groundedness_checker',
      message: groundedness.passed
        ? 'Groundedness audit completed successfully.'
        : 'Groundedness audit completed with validation findings.',
      payload: {
        passed: groundedness.passed,
        score: groundedness.score,
        validationStatus: 'complete',
      },
    });

    return {
      report: updatedReport,
      groundedness,
      currentStep: 'quality_evaluator',
      completedAgents: ['groundedness_checker'],
    };
  };

  // 13. Research Quality Evaluator & Conditional Router Node (LangGraph Command)
  const qualityEvaluatorNode = async (state: OrchestraGraphState) => {
    if (!state.plan || !state.groundedness) {
      throw new Error('Quality Evaluator requires plan and groundedness evaluation.');
    }

    emit({
      sessionId: state.sessionId,
      eventType: 'agent_started',
      agentId: 'quality_evaluator',
      payload: { timeoutMs: Math.max(10_000, Number(process.env.AGENT_REQUEST_TIMEOUT_MS) || 90_000) },
      message: 'Evaluating overall completeness and selecting conditional LangGraph route.',
    });

    const quality = await withNodeRetry(
      () =>
        agents.qualityEvaluator({
          question: state.question,
          plan: state.plan!,
          claims: state.claims,
          groundedness: state.groundedness!,
        }),
      maxNodeAttempts,
      nodeRetryDelayMs
    );

    const evaluatedState: OrchestraGraphState = {
      ...state,
      quality,
    };
    const route = decidePostQualityRoute(evaluatedState);

    if (route.action === 'rewrite_report') {
      emit({
        sessionId: state.sessionId,
        eventType: 'research_retry',
        agentId: 'quality_evaluator',
        message: route.reason,
        payload: {
          retryCount: state.retryCount + 1,
          routeAction: route.action,
          rewriteDirectives: route.rewriteInstructions.length,
        },
      });

      return new Command({
        goto: 'writer',
        update: {
          quality,
          rewriteInstructions: route.rewriteInstructions,
          routeAction: route.action,
          status: 'running',
          currentStep: 'writer',
          completedAgents: [...state.completedAgents, 'quality_evaluator'],
          executionCycle: createExecutionCycle(state.retryCount + 1, 'writer', 'running', [...(state.executionCycle?.completedAgents ?? state.completedAgents), 'quality_evaluator']),
        },
      });
    }

    if (route.action === 'recheck_contradictions') {
      emit({
        sessionId: state.sessionId,
        eventType: 'research_retry',
        agentId: 'quality_evaluator',
        message: route.reason,
        payload: {
          retryCount: state.retryCount + 1,
          routeAction: route.action,
        },
      });

      return new Command({
        goto: 'contradiction_checker',
        update: {
          quality,
          contradictionRechecked: true,
          routeAction: route.action,
          status: 'running',
          currentStep: 'contradiction_checker',
          completedAgents: [...state.completedAgents, 'quality_evaluator'],
          executionCycle: createExecutionCycle(state.retryCount + 1, 'contradiction_checker', 'running', [...(state.executionCycle?.completedAgents ?? state.completedAgents), 'quality_evaluator']),
        },
      });
    }

    if (route.action === 'retry_research') {
      emit({
        sessionId: state.sessionId,
        eventType: 'research_retry',
        agentId: 'quality_evaluator',
        message: route.reason,
        payload: {
          retryCount: state.retryCount + 1,
          routeAction: route.action,
          recommendedQueries: route.extraQueries,
        },
      });

      return new Command({
        goto: 'research_coordinator',
        update: {
          quality,
          retryCount: state.retryCount + 1,
          executionCycle: createExecutionCycle(state.retryCount + 2, 'research_coordinator', 'running'),
          completedAgents: [],
          extraQueries: route.extraQueries,
          routeAction: route.action,
          status: 'running',
          currentStep: 'research_coordinator',
        },
      });
    }

    emit({
      sessionId: state.sessionId,
      eventType: 'execution_completed',
      agentId: 'quality_evaluator',
      message: route.reason,
      payload: {
        status: route.finalStatus,
        groundednessPassed: state.groundedness.passed,
        groundednessScore: state.groundedness.score,
      },
    });

    return new Command({
      goto: END,
      update: {
        quality,
        routeAction: 'complete',
        status: route.finalStatus,
        currentStep: 'quality_evaluator',
        completedAgents: [...state.completedAgents, 'quality_evaluator'],
        executionCycle: createExecutionCycle(state.retryCount + 1, 'quality_evaluator', route.finalStatus, [...(state.executionCycle?.completedAgents ?? state.completedAgents), 'quality_evaluator']),
      },
    });
  };

  const builder = new StateGraph(OrchestraStateAnnotation)
    .addNode('input_validation', inputValidationNode)
    .addNode('planner', plannerNode)
    .addNode('human_approval', humanApprovalNode, {
      ends: ['planner', 'research_coordinator', END],
    })
    .addNode('research_coordinator', researchCoordinatorNode)
    .addNode('researcher_worker', researcherWorkerNode)
    .addNode('evidence_extraction', evidenceExtractionNode)
    .addNode('fact_checker', factCheckerNode)
    .addNode('source_credibility', sourceCredibilityNode)
    .addNode('contradiction_checker', contradictionCheckerNode)
    .addNode('summarizer', summarizerNode)
    .addNode('writer', writerNode)
    .addNode('groundedness_checker', groundednessCheckerNode, { ends: [END] })
    .addNode('quality_evaluator', qualityEvaluatorNode, {
      ends: ['research_coordinator', 'contradiction_checker', 'writer', END],
    })
    .addEdge(START, 'input_validation')
    .addEdge('input_validation', 'planner')
    .addEdge('planner', 'human_approval')
    .addConditionalEdges('research_coordinator', fanOutParallelResearchers, [
      'researcher_worker',
      'evidence_extraction',
    ])
    .addEdge('researcher_worker', 'evidence_extraction')
    .addEdge('evidence_extraction', 'fact_checker')
    .addEdge('fact_checker', 'source_credibility')
    .addEdge('source_credibility', 'contradiction_checker')
    .addEdge('contradiction_checker', 'summarizer')
    .addEdge('summarizer', 'writer')
    .addEdge('writer', 'groundedness_checker')
    .addEdge('groundedness_checker', 'quality_evaluator');

  return builder.compile({ checkpointer });
}
