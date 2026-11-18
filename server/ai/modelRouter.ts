import { AsyncLocalStorage } from 'node:async_hooks';
import { GEMINI_MODEL_OPTIONS, type AgentModelRouting, type GeminiModelId } from '../../src/types/research';

export type ModelRole = keyof AgentModelRouting;

export const DEFAULT_AGENT_MODEL_ROUTING: AgentModelRouting = {
  planner: 'gemini-4-hydrogen',
  researcher: 'gemini-3.8-flash',
  evidenceExtractor: 'gemini-3.6-flash',
  factChecker: 'gemini-4-hydrogen',
  sourceCredibility: 'gemini-3.5-flash-lite',
  contradictionChecker: 'gemini-4-hydrogen',
  summarizer: 'gemini-3.1-flash-lite',
  writer: 'gemini-3.8-flash',
  groundednessChecker: 'gemini-4-hydrogen',
  qualityEvaluator: 'gemini-3.6-flash',
};

const FALLBACK_MODELS: Record<ModelRole, GeminiModelId[]> = {
  planner: ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'],
  researcher: ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'],
  evidenceExtractor: ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],
  factChecker: ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'],
  sourceCredibility: ['gemini-3.1-flash-lite', 'gemini-3.6-flash', 'gemini-2.5-flash-lite'],
  contradictionChecker: ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'],
  summarizer: ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-2.5-flash-lite'],
  writer: ['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash'],
  groundednessChecker: ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'],
  qualityEvaluator: ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],
};

const routingContext = new AsyncLocalStorage<Partial<AgentModelRouting>>();

export function normalizeModelRouting(input: unknown, base: AgentModelRouting = DEFAULT_AGENT_MODEL_ROUTING): AgentModelRouting {
  const allowed = new Set<string>(GEMINI_MODEL_OPTIONS.map((option) => option.value));
  const candidate = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const result = { ...base };
  for (const role of Object.keys(DEFAULT_AGENT_MODEL_ROUTING) as ModelRole[]) {
    const value = candidate[role];
    if (typeof value === 'string' && allowed.has(value)) result[role] = value as GeminiModelId;
  }
  return result;
}

export function runWithModelRouting<T>(routing: Partial<AgentModelRouting>, callback: () => T): T {
  return routingContext.run(routing, callback);
}

export function getModelCandidates(role: ModelRole): GeminiModelId[] {
  const contextOverride = routingContext.getStore()?.[role];
  const envKey = `GEMINI_MODEL_${role.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`;
  const envOverride = process.env[envKey]?.trim();
  const primary = contextOverride || (envOverride as GeminiModelId | undefined) || DEFAULT_AGENT_MODEL_ROUTING[role];
  const allowed = new Set<string>(GEMINI_MODEL_OPTIONS.map((option) => option.value));
  const selected = allowed.has(primary) ? primary : DEFAULT_AGENT_MODEL_ROUTING[role];
  return Array.from(new Set<GeminiModelId>([selected, ...FALLBACK_MODELS[role]])).filter((model) => allowed.has(model));
}

export function isModelFallbackWorthy(error: unknown): boolean {
  const err = error as { status?: number; statusCode?: number; code?: number | string; message?: string };
  const status = Number(err?.status ?? err?.statusCode ?? err?.code);
  const message = String(err?.message ?? error ?? '').toLowerCase();
  return status === 404 || status === 429 || (status >= 500 && status <= 599) ||
    /resource_exhausted|quota exceeded|rate.?limit|too many requests|model not found/.test(message);
}

export function isRetryableServerError(error: unknown): boolean {
  const err = error as { status?: number; statusCode?: number; code?: number | string };
  const status = Number(err?.status ?? err?.statusCode ?? err?.code);
  return status >= 500 && status <= 599;
}
