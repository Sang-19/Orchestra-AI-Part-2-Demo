export type AgentId =
  | 'input_validation'
  | 'planner'
  | 'human_approval'
  | 'research_coordinator'
  | 'researcher'
  | 'evidence_extraction'
  | 'fact_checker'
  | 'source_credibility'
  | 'contradiction_checker'
  | 'summarizer'
  | 'writer'
  | 'groundedness_checker'
  | 'quality_evaluator';

export type ResearchMode = 'standard' | 'deep' | 'document_focused';

export type ResearchStatus =
  | 'planning'
  | 'awaiting_approval'
  | 'running'
  | 'paused'
  | 'rejected'
  | 'completed'
  | 'completed_with_warnings'
  | 'failed';

export interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  createdAt: string;
}


export const GEMINI_MODEL_OPTIONS = [
  { value: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen' },
  { value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
  { value: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
  { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash' },
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
  { value: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite' },
  { value: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite' },
] as const;

export type GeminiModelId = (typeof GEMINI_MODEL_OPTIONS)[number]['value'];

export interface AgentModelRouting {
  planner: GeminiModelId;
  researcher: GeminiModelId;
  evidenceExtractor: GeminiModelId;
  factChecker: GeminiModelId;
  sourceCredibility: GeminiModelId;
  contradictionChecker: GeminiModelId;
  summarizer: GeminiModelId;
  writer: GeminiModelId;
  groundednessChecker: GeminiModelId;
  qualityEvaluator: GeminiModelId;
}

export interface UserSettings {
  userId: string;
  defaultMode: ResearchMode;
  maxRetries: number;
  groundednessThreshold: number;
  citationStyle: 'numeric' | 'apa' | 'ieee';
  reportTone: 'academic' | 'executive' | 'technical';
  includeWebDefault: boolean;
  includeRagDefault: boolean;
  notifyOnComplete: boolean;
  notifyOnFailure: boolean;
  modelRouting: AgentModelRouting;
  updatedAt: string;
}

export interface PlanSubtopic {
  id: string;
  title: string;
  description: string;
  searchQueries: string[];
  requiredInformation: string[];
  priority: 'high' | 'medium' | 'low';
}

export interface ResearchPlan {
  objective: string;
  methodologyNote: string;
  subtopics: PlanSubtopic[];
  potentialDifficulties: string[];
  estimatedCycles: number;
}

export interface SourceRecord {
  id: string;
  citationNumber: number;
  title: string;
  url: string;
  domain: string;
  snippet: string;
  publishedAt: string | null;
  sourceType: 'web' | 'document';
  subtopicId: string;
  credibilityScore: number;
  credibilityTier: 'primary' | 'secondary' | 'tertiary';
  credibilityReasoning: string;
  isOutdated: boolean;
  isDuplicate: boolean;
}

export interface ClaimRecord {
  id: string;
  statement: string;
  category: 'fact' | 'opinion' | 'assumption';
  subtopicId: string;
  sourceId: string;
  supportingPassage: string;
  publishedAt: string | null;
  verificationStatus: 'supported' | 'partially_supported' | 'unsupported' | 'conflicting';
  confidenceScore: number;
  verificationReasoning: string;
}

export interface ContradictionRecord {
  id: string;
  topic: string;
  claimAId: string;
  claimBId: string;
  claimAStatement: string;
  claimBStatement: string;
  summary: string;
  severity: 'high' | 'moderate' | 'contextual';
  resolutionStatus: 'unresolved' | 'contextual_difference' | 'recency_superseded';
  reasoning: string;
}

export interface GroundednessResult {
  /** AI audit completion state; absent means the legacy complete result shape. */
  validationStatus?: 'complete' | 'incomplete';
  passed: boolean;
  score: number;
  totalStatementsChecked: number;
  unsupportedStatements: string[];
  citationIssues: string[];
  summary: string;
}

export interface QualityEvaluation {
  completenessScore: number;
  evidenceCoverage: number;
  missingSubtopics: string[];
  unansweredQuestions: string[];
  shouldRetry: boolean;
  recommendedQueries: string[];
  reasoning: string;
}

export interface TopicFindingSection {
  subtopicId: string;
  title: string;
  summary: string;
  keyDiscoveries: string[];
  knowledgeGaps: string[];
  citationNumbers: number[];
}

export interface ResearchReport {
  title: string;
  executiveSummary: string;
  introduction: string;
  researchObjectives: string[];
  methodology: string;
  detailedFindings: string;
  topicAnalysis: TopicFindingSection[];
  evidenceAndCitationsSummary: string;
  contradictoryFindingsSummary: string;
  limitations: string[];
  conclusion: string;
  markdownContent: string;
  generatedAt: string;
}

export interface ExecutionCycleState {
  cycleNumber: number;
  activeAgent: AgentId | null;
  completedAgents: AgentId[];
  failedAgents: AgentId[];
  status: ResearchStatus;
}

export interface WorkflowCheckpoint {
  sessionId: string;
  currentStep: AgentId;
  completedAgents: AgentId[];
  /** Current-cycle view; optional for legacy persisted checkpoints. */
  executionCycle?: ExecutionCycleState;
  retryCount: number;
  maxRetries: number;
  plan: ResearchPlan | null;
  sources: SourceRecord[];
  claims: ClaimRecord[];
  contradictions: ContradictionRecord[];
  topicSummaries: TopicFindingSection[];
  report: ResearchReport | null;
  groundedness: GroundednessResult | null;
  quality: QualityEvaluation | null;
  lastUpdatedAt: string;
}

export interface ResearchSession {
  id: string;
  userId: string;
  question: string;
  mode: ResearchMode;
  status: ResearchStatus;
  includeWeb: boolean;
  includeRag: boolean;
  collectionIds: string[];
  maxRetries: number;
  retryCount: number;
  currentAgent: AgentId | null;
  executionCycle?: ExecutionCycleState;
  plan: ResearchPlan | null;
  checkpoint: WorkflowCheckpoint | null;
  report: ResearchReport | null;
  groundedness: GroundednessResult | null;
  quality: QualityEvaluation | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionEvent {
  id: string;
  sessionId: string;
  seq: number;
  /** Cycle association; omitted by legacy persisted events. */
  cycleNumber?: number;
  eventType:
    | 'execution_started'
    | 'agent_started'
    | 'agent_progress'
    | 'agent_completed'
    | 'evidence_discovered'
    | 'research_retry'
    | 'validation_result'
    | 'approval_required'
    | 'execution_completed'
    | 'execution_failed'
    | 'execution_paused';
  agentId: AgentId | null;
  message: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface CollectionRecord {
  id: string;
  userId: string;
  name: string;
  description: string;
  documentCount: number;
  createdAt: string;
}

export interface DocumentRecord {
  id: string;
  userId: string;
  collectionId: string | null;
  collectionName: string | null;
  filename: string;
  mimeType: string;
  fileSize: number;
  status: 'processing' | 'indexed' | 'duplicate' | 'failed';
  chunkCount: number;
  charCount: number;
  errorMessage: string | null;
  createdAt: string;
}

export interface RetrievalMatch {
  chunkId: string;
  documentId: string;
  filename: string;
  collectionId: string | null;
  chunkIndex: number;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface SessionMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  citations: number[];
  createdAt: string;
}

export interface DashboardStats {
  totalSessions: number;
  completedSessions: number;
  activeSessions: number;
  failedSessions: number;
  awaitingApprovalSessions: number;
  totalDocuments: number;
  totalChunks: number;
  totalCollections: number;
  totalClaimsVerified: number;
  averageGroundedness: number | null;
}

export interface ToolStatus {
  id: string;
  name: string;
  category: string;
  configured: boolean;
  mode: string;
  description: string;
  capabilities: string[];
}

export type CustomToolType = 'http_search' | 'ollama_model' | 'webhook_tool' | 'mcp_endpoint';

export interface CustomToolRecord {
  id: string;
  userId: string;
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
  lastTestedAt: string | null;
  lastTestStatus: 'untested' | 'ok' | 'error';
  lastTestMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ToolTestResult {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  message: string;
  details?: string[];
}

