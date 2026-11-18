import React, { useState } from 'react';
import { Play, Globe, Database, SlidersHorizontal, Sparkles, Cpu } from 'lucide-react';
import { apiClient } from '../services/apiClient';
import type {
  AIProvider,
  CollectionRecord,
  ResearchMode,
  ResearchSession,
  UserSettings,
} from '../types/research';

interface NewResearchViewProps {
  collections: CollectionRecord[];
  settings: UserSettings | null;
  onCreatedSession: (session: ResearchSession) => void;
}

const SAMPLE_PROMPTS = [
  'Analyze the commercial readiness and safety tradeoffs of solid-state electrolytes vs. high-nickel NMC for EV packs by 2028.',
  'Evaluate open-weight vs. proprietary multimodal AI governance frameworks in enterprise healthcare compliance.',
  'Compare direct air capture (DAC) energy costs per ton of CO2 across solid sorbent and liquid solvent architectures.',
];

export function NewResearchView({
  collections,
  settings,
  onCreatedSession,
}: NewResearchViewProps) {
  const [question, setQuestion] = useState('');
  const [provider, setProvider] = useState<AIProvider>('gemini');
  const [mode, setMode] = useState<ResearchMode>(settings?.defaultMode ?? 'standard');
  const [includeWeb, setIncludeWeb] = useState<boolean>(settings?.includeWebDefault ?? true);
  const [includeRag, setIncludeRag] = useState<boolean>(settings?.includeRagDefault ?? true);
  const [selectedCollections, setSelectedCollections] = useState<string[]>([]);
  const [maxRetries, setMaxRetries] = useState<number>(settings?.maxRetries ?? 2);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleCollection = (id: string) => {
    setSelectedCollections((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (question.trim().length < 8) {
      setError('Please enter a research question of at least 8 characters.');
      return;
    }
    if (!includeWeb && !includeRag) {
      setError('Enable at least one knowledge source (Web Search or Knowledge Base).');
      return;
    }

    setSubmitting(true);
    try {
      const res = await apiClient.createResearchSession({
        question: question.trim(),
        mode,
        includeWeb,
        includeRag,
        collectionIds: selectedCollections,
        maxRetries,
        provider,
      });
      onCreatedSession(res.session);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to initialize research plan.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Launch Autonomous Research
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          The Planner Agent will decompose your question into subtopics and search queries, then pause for your approval before dispatching parallel research agents.
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-6"
      >
        {error && (
          <div
            role="alert"
            className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700"
          >
            {error}
          </div>
        )}

        <div>
          <label htmlFor="research-question" className="block text-sm font-medium text-slate-800 mb-2">
            Research Question or Investigation Brief
          </label>
          <textarea
            id="research-question"
            rows={4}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="e.g., Compare LFP vs. sodium-ion battery architectures for utility-scale 4-hour grid storage deployment through 2027..."
            className="w-full px-4 py-3 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent leading-relaxed"
          />
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-500">Examples:</span>
            {SAMPLE_PROMPTS.map((sample, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => setQuestion(sample)}
                className="text-xs text-blue-700 hover:text-blue-900 underline underline-offset-2 text-left"
              >
                Sample {idx + 1}
              </button>
            ))}
          </div>
        </div>

        {/* AI Provider */}
        <div className="pt-4 border-t border-slate-100">
          <div className="text-sm font-medium text-slate-800 mb-3">Choose AI Provider</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button type="button" onClick={() => setProvider('gemini')} aria-pressed={provider === 'gemini'} className={`p-4 rounded-lg border text-left transition-colors ${provider === 'gemini' ? 'border-blue-700 bg-blue-50/50 ring-1 ring-blue-700' : 'border-slate-200 hover:border-slate-300'}`}>
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-900"><Sparkles className="w-4 h-4 text-blue-700" /> Google Gemini</div>
              <p className="mt-1 text-xs text-slate-500">Cloud-hosted AI using your configured Gemini API key.</p>
            </button>
            <button type="button" onClick={() => setProvider('ollama')} aria-pressed={provider === 'ollama'} className={`p-4 rounded-lg border text-left transition-colors ${provider === 'ollama' ? 'border-emerald-700 bg-emerald-50/50 ring-1 ring-emerald-700' : 'border-slate-200 hover:border-slate-300'}`}>
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-900"><Cpu className="w-4 h-4 text-emerald-700" /> Ollama (Local)</div>
              <p className="mt-1 text-xs text-slate-500">Run agent reasoning locally. Live web discovery still requires Tavily when Ollama is selected.</p>
            </button>
          </div>
          {provider === 'ollama' && <p className="mt-2 text-xs text-amber-700">Make sure Ollama is running and OLLAMA_BASE_URL / OLLAMA_MODEL are configured on the Orchestra server.</p>}
        </div>

        {/* Research Mode */}
        <div className="pt-4 border-t border-slate-100">
          <div className="text-sm font-medium text-slate-800 mb-3">Research Depth Mode</div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {[
              {
                id: 'standard' as const,
                title: 'Standard Synthesis',
                desc: '3 subtopics · balanced speed and verification depth',
              },
              {
                id: 'deep' as const,
                title: 'Deep Multi-Cycle',
                desc: '4 subtopics · thorough contradiction & adaptive retries',
              },
              {
                id: 'document_focused' as const,
                title: 'Document-Focused',
                desc: 'Prioritizes private RAG collections over open web',
              },
            ].map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setMode(item.id);
                  if (item.id === 'document_focused') {
                    setIncludeRag(true);
                  }
                }}
                className={`p-4 rounded-lg border text-left transition-colors ${
                  mode === item.id
                    ? 'border-blue-700 bg-blue-50/50 text-slate-900'
                    : 'border-slate-200 hover:border-slate-300 text-slate-700'
                }`}
              >
                <div className="text-sm font-semibold">{item.title}</div>
                <div className="mt-1 text-xs text-slate-500 leading-relaxed">{item.desc}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Knowledge Sources & Collections */}
        <div className="pt-4 border-t border-slate-100 grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-3">
            <div className="text-sm font-medium text-slate-800">Knowledge Sources</div>

            <label className="flex items-start gap-3 p-3.5 rounded-lg border border-slate-200 cursor-pointer hover:bg-slate-50">
              <input
                type="checkbox"
                checked={includeWeb}
                onChange={(e) => setIncludeWeb(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-700 focus:ring-blue-600"
              />
              <div>
                <div className="flex items-center gap-1.5 text-sm font-medium text-slate-900">
                  <Globe className="w-4 h-4 text-slate-500" />
                  <span>Live Web Discovery</span>
                </div>
                <div className="text-xs text-slate-500 mt-0.5">
                  Queries Tavily API or Gemini Google Search Grounding with source URL tracking.
                </div>
              </div>
            </label>

            <label className="flex items-start gap-3 p-3.5 rounded-lg border border-slate-200 cursor-pointer hover:bg-slate-50">
              <input
                type="checkbox"
                checked={includeRag}
                onChange={(e) => setIncludeRag(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-blue-700 focus:ring-blue-600"
              />
              <div>
                <div className="flex items-center gap-1.5 text-sm font-medium text-slate-900">
                  <Database className="w-4 h-4 text-slate-500" />
                  <span>Private Knowledge Base (RAG)</span>
                </div>
                <div className="text-xs text-slate-500 mt-0.5">
                  Retrieves top-K semantic chunks from your isolated uploaded documents.
                </div>
              </div>
            </label>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-slate-800">
                Target Collections {selectedCollections.length > 0 && `(${selectedCollections.length})`}
              </span>
              <span className="text-xs text-slate-500">Leave unchecked to search all</span>
            </div>

            {collections.length === 0 ? (
              <div className="p-4 rounded-lg border border-dashed border-slate-200 text-xs text-slate-500">
                No custom collections created yet. All indexed documents in your workspace will be queried when RAG is enabled.
              </div>
            ) : (
              <div className="space-y-2 max-h-40 overflow-y-auto pr-1">
                {collections.map((col) => (
                  <label
                    key={col.id}
                    className="flex items-center justify-between gap-3 p-2.5 rounded-lg border border-slate-200 hover:bg-slate-50 cursor-pointer"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <input
                        type="checkbox"
                        checked={selectedCollections.includes(col.id)}
                        onChange={() => toggleCollection(col.id)}
                        disabled={!includeRag}
                        className="h-4 w-4 rounded border-slate-300 text-blue-700"
                      />
                      <span className="text-sm text-slate-800 truncate">{col.name}</span>
                    </div>
                    <span className="text-xs text-slate-500 font-mono tabular-nums shrink-0">
                      {col.documentCount} files
                    </span>
                  </label>
                ))}
              </div>
            )}

            <div className="pt-2">
              <label
                htmlFor="max-retries-select"
                className="flex items-center gap-1.5 text-xs font-medium text-slate-700 mb-1.5"
              >
                <SlidersHorizontal className="w-3.5 h-3.5 text-slate-500" />
                <span>Adaptive Research Retry Limit</span>
              </label>
              <select
                id="max-retries-select"
                value={maxRetries}
                onChange={(e) => setMaxRetries(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-blue-600"
              >
                <option value={0}>0 retries (single pass)</option>
                <option value={1}>Up to 1 adaptive retry</option>
                <option value={2}>Up to 2 adaptive retries (recommended)</option>
                <option value={3}>Up to 3 adaptive retries</option>
              </select>
            </div>
          </div>
        </div>

        <div className="pt-4 border-t border-slate-200 flex items-center justify-end gap-3">
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-60 text-white text-sm font-medium transition-colors whitespace-nowrap"
          >
            <Play className="w-4 h-4" />
            <span>{submitting ? 'Starting Research...' : 'Generate Research Plan'}</span>
          </button>
        </div>
      </form>
    </div>
  );
}
