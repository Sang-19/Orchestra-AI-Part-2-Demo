import { Annotation } from '@langchain/langgraph';
import { deduplicateAndNumberSources } from '../tools/researchTools';
import type {
  AgentId,
  ExecutionCycleState,
  ClaimRecord,
  ContradictionRecord,
  GroundednessResult,
  PlanSubtopic,
  QualityEvaluation,
  ResearchMode,
  ResearchPlan,
  ResearchReport,
  ResearchStatus,
  SourceRecord,
  TopicFindingSection,
  WorkflowCheckpoint,
} from '../../src/types/research';

/**
 * Deterministic reducer for parallel Send() researcher branches.
 * Prevents concurrent state-update conflicts and guarantees stable citation numbering.
 */
export function mergeSourcesReducer(
  left: SourceRecord[],
  right: SourceRecord[]
): SourceRecord[] {
  if (!right || right.length === 0) return left;
  // Special case: if right carries updated credibility metadata for already-known IDs,
  // update those records in place while preserving any new URLs.
  const rightById = new Map(right.map((s) => [s.id, s]));
  const updatedExisting = left.map((src) => rightById.get(src.id) ?? src);
  return deduplicateAndNumberSources(updatedExisting, right);
}

/** Merge concurrent Send() deltas; a retry cycle supplies its own empty baseline. */
export function mergeCompletedAgentsReducer(left: AgentId[], right: AgentId[]): AgentId[] {
  if (!right || right.length === 0) return left;
  return Array.from(new Set<AgentId>([...left, ...right]));
}

export function createExecutionCycle(cycleNumber: number, activeAgent: AgentId | null, status: ResearchStatus, completedAgents: AgentId[] = [], failedAgents: AgentId[] = []): ExecutionCycleState {
  return { cycleNumber, activeAgent, completedAgents: Array.from(new Set(completedAgents)), failedAgents: Array.from(new Set(failedAgents)), status };
}

export function mergeStringsReducer(left: string[], right: string[]): string[] {
  if (!right || right.length === 0) return left;
  return Array.from(new Set([...left, ...right]));
}

export type QualityRouteAction =
  | 'complete'
  | 'retry_research'
  | 'rewrite_report'
  | 'recheck_contradictions';

/**
 * Shared typed LangGraph state for the Orchestra AI research pipeline.
 */
export const OrchestraStateAnnotation = Annotation.Root({
  sessionId: Annotation<string>(),
  userId: Annotation<string>(),
  question: Annotation<string>(),
  mode: Annotation<ResearchMode>(),
  includeWeb: Annotation<boolean>(),
  includeRag: Annotation<boolean>(),
  collectionIds: Annotation<string[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  maxRetries: Annotation<number>({
    reducer: (_left, right) => right,
    default: () => 2,
  }),
  groundednessThreshold: Annotation<number>({
    reducer: (_left, right) => right,
    default: () => 0.75,
  }),
  reportTone: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => 'executive',
  }),
  citationStyle: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => 'numeric',
  }),

  // Execution lifecycle tracking
  executionCycle: Annotation<ExecutionCycleState>({
    reducer: (_left, right) => right,
    default: () => createExecutionCycle(1, 'input_validation', 'planning'),
  }),
  status: Annotation<ResearchStatus>({
    reducer: (_left, right) => right,
    default: () => 'planning',
  }),
  currentStep: Annotation<AgentId>({
    reducer: (_left, right) => right,
    default: () => 'input_validation',
  }),
  completedAgents: Annotation<AgentId[]>({
    reducer: mergeCompletedAgentsReducer,
    default: () => [],
  }),
  retryCount: Annotation<number>({
    reducer: (_left, right) => right,
    default: () => 0,
  }),
  contradictionRechecked: Annotation<boolean>({
    reducer: (_left, right) => right,
    default: () => false,
  }),

  // Human approval & revision feedback
  plannerFeedback: Annotation<string | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  approvalDecision: Annotation<'pending' | 'approved' | 'rejected' | 'revise'>({
    reducer: (_left, right) => right,
    default: () => 'pending',
  }),
  rejectionReason: Annotation<string | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),

  // Research artifacts
  plan: Annotation<ResearchPlan | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  extraQueries: Annotation<string[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  rewriteInstructions: Annotation<string[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  sources: Annotation<SourceRecord[]>({
    reducer: mergeSourcesReducer,
    default: () => [],
  }),
  researchGaps: Annotation<string[]>({
    reducer: mergeStringsReducer,
    default: () => [],
  }),
  claims: Annotation<ClaimRecord[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  contradictions: Annotation<ContradictionRecord[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  topicSummaries: Annotation<TopicFindingSection[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  report: Annotation<ResearchReport | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  groundedness: Annotation<GroundednessResult | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  quality: Annotation<QualityEvaluation | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  routeAction: Annotation<QualityRouteAction | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  errorMessage: Annotation<string | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
});

export type OrchestraGraphState = typeof OrchestraStateAnnotation.State;
export type OrchestraGraphUpdate = typeof OrchestraStateAnnotation.Update;

/**
 * Payload dispatched dynamically to `researcher_worker` via LangGraph `Send()`.
 */
export interface SubtopicResearchTaskInput {
  sessionId: string;
  userId: string;
  objective: string;
  subtopic: PlanSubtopic;
  includeWeb: boolean;
  includeRag: boolean;
  collectionIds: string[];
  extraQueries: string[];
  startingCitationNumber: number;
}

/**
 * Resume payload accepted by LangGraph `interrupt()` inside the `human_approval` node.
 */
export interface HumanApprovalResumePayload {
  action: 'approve' | 'revise' | 'reject';
  updatedPlan?: ResearchPlan;
  feedback?: string;
  reason?: string;
}

/**
 * Projects LangGraph shared state into the existing API/frontend `WorkflowCheckpoint` shape
 * so the frontend never needs to understand LangGraph internals.
 */
export function projectGraphStateToCheckpoint(state: OrchestraGraphState): WorkflowCheckpoint {
  return {
    sessionId: state.sessionId,
    currentStep: state.currentStep,
    completedAgents: state.executionCycle?.completedAgents ?? state.completedAgents,
    executionCycle: state.executionCycle ?? createExecutionCycle(state.retryCount + 1, state.currentStep, state.status, state.completedAgents),
    retryCount: state.retryCount,
    maxRetries: state.maxRetries,
    plan: state.plan,
    sources: state.sources,
    claims: state.claims,
    contradictions: state.contradictions,
    topicSummaries: state.topicSummaries,
    report: state.report,
    groundedness: state.groundedness,
    quality: state.quality,
    lastUpdatedAt: new Date().toISOString(),
  };
}
