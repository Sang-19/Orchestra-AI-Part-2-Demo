import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  Edit3,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { apiClient } from '../services/apiClient';
import type {
  CustomToolRecord,
  CustomToolType,
  ToolStatus,
} from '../types/research';

interface ToolFormState {
  name: string;
  toolType: CustomToolType;
  category: string;
  endpointUrl: string;
  httpMethod: 'GET' | 'POST';
  modelName: string;
  authEnvVar: string;
  description: string;
  capabilitiesText: string;
  enabled: boolean;
}

const EMPTY_FORM: ToolFormState = {
  name: '',
  toolType: 'http_search',
  category: 'Custom Search API',
  endpointUrl: '',
  httpMethod: 'GET',
  modelName: '',
  authEnvVar: '',
  description: '',
  capabilitiesText: '',
  enabled: true,
};

const QUICK_TEMPLATES: Array<{ label: string; values: ToolFormState }> = [
  {
    label: 'ArXiv Academic Search',
    values: {
      name: 'ArXiv Preprint Search',
      toolType: 'http_search',
      category: 'Academic Search',
      endpointUrl:
        'https://export.arxiv.org/api/query?search_query=all:{{query}}&start=0&max_results=3',
      httpMethod: 'GET',
      modelName: '',
      authEnvVar: '',
      description:
        'Queries public ArXiv scientific preprints by keyword and returns sanitized XML summaries to the Researcher Agent.',
      capabilitiesText: 'Scientific Preprints, Physics & CS Papers, No Key Required',
      enabled: true,
    },
  },
  {
    label: 'Wikipedia Search API',
    values: {
      name: 'Wikipedia Search API',
      toolType: 'http_search',
      category: 'Reference Knowledge',
      endpointUrl:
        'https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch={{query}}&format=json',
      httpMethod: 'GET',
      modelName: '',
      authEnvVar: '',
      description:
        'Retrieves encyclopedic search snippets from Wikipedia to cross-check background definitions and dates.',
      capabilitiesText: 'Encyclopedic Context, Entity Discovery, Public REST API',
      enabled: true,
    },
  },
  {
    label: 'Local Ollama Model',
    values: {
      name: 'Local Ollama (Llama 3.1)',
      toolType: 'ollama_model',
      category: 'Local LLM',
      endpointUrl: 'http://localhost:11434',
      httpMethod: 'POST',
      modelName: 'llama3.1:8b',
      authEnvVar: '',
      description:
        'Self-hosted local Ollama inference server used when running Orchestra AI locally with LLM_PROVIDER=ollama.',
      capabilitiesText: 'Offline Inference, JSON Output Mode, Local Embeddings',
      enabled: true,
    },
  },
];

const TOOL_TYPE_LABELS: Record<CustomToolType, string> = {
  http_search: 'Custom HTTP Search API',
  ollama_model: 'Local Ollama Model Connector',
  webhook_tool: 'Custom Agent Webhook / API',
  mcp_endpoint: 'External MCP / Tool Server',
};

const GUIDE_MARKDOWN = `# Orchestra AI — Tools, Agent Integrations & Local Ollama Breakdown

## 1. Built-In Agent Integrations
- Google Gemini Reasoning Engine (gemini-4-hydrogen): Powers all 10 research agents (Planner, Evidence Extraction, Fact Checker, Source Credibility, Contradiction Checker, Summarizer, Writer, Groundedness Checker, Quality Evaluator).
- Ollama Local Model Backend (server/ai/ollamaClient.ts): Optional local inference backend via LLM_PROVIDER=ollama.
- Vector Embeddings Engine: Uses gemini-embedding-2 (or ollama:nomic-embed-text locally) with deterministic fallback.
- Tavily Web Search API (Optional): Deep web search via TAVILY_API_KEY; falls back to Gemini Google Search Grounding.
- SQLite Checkpoint & Vector Store: Zero-setup WAL persistence for checkpoints, users, documents, and custom tools.
- Document Ingestion Pipeline: Parses PDF, DOCX, MD, TXT, CSV, and JSON with SHA-256 deduplication.

## 2. User-Generated Tools in the Website
- Add custom HTTP Search APIs using {{query}} in the URL (GET) or JSON body { "query": "..." } (POST).
- Enabled HTTP Search / Webhook tools are automatically queried by the Researcher Agent during research sessions.
- Keep secrets server-side: only enter the server environment variable NAME (e.g., MY_API_TOKEN) in the UI, and set its value in .env.

## 3. Running Locally with Ollama
1. Install Ollama and pull models:
   ollama pull llama3.1:8b
   ollama pull nomic-embed-text
2. Set in your local .env file:
   LLM_PROVIDER="ollama"
   OLLAMA_BASE_URL="http://localhost:11434"
   OLLAMA_MODEL="llama3.1:8b"
   OLLAMA_EMBED_MODEL="nomic-embed-text"
3. Run locally:
   npm install && npm run dev
`;

export function ToolsView() {
  const [activeSection, setActiveSection] = useState<'custom' | 'builtin' | 'guide'>('custom');
  const [tools, setTools] = useState<ToolStatus[]>([]);
  const [customTools, setCustomTools] = useState<CustomToolRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const [showBuilder, setShowBuilder] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ToolFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadTools = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.getToolsStatus();
      setTools(res.tools);
      setCustomTools(res.customTools ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to fetch integration status.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTools();
  }, []);

  const openCreateForm = (template?: ToolFormState) => {
    setEditingId(null);
    setForm(template ? { ...template } : { ...EMPTY_FORM });
    setShowBuilder(true);
    setError(null);
    setFeedback(null);
  };

  const openEditForm = (tool: CustomToolRecord) => {
    setEditingId(tool.id);
    setForm({
      name: tool.name,
      toolType: tool.toolType,
      category: tool.category,
      endpointUrl: tool.endpointUrl,
      httpMethod: tool.httpMethod,
      modelName: tool.modelName,
      authEnvVar: tool.authEnvVar,
      description: tool.description,
      capabilitiesText: tool.capabilities.join(', '),
      enabled: tool.enabled,
    });
    setShowBuilder(true);
    setError(null);
    setFeedback(null);
  };

  const handleSaveTool = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setFeedback(null);

    const payload = {
      name: form.name.trim(),
      toolType: form.toolType,
      category: form.category.trim() || 'Custom Integration',
      endpointUrl: form.endpointUrl.trim(),
      httpMethod: form.httpMethod,
      modelName: form.modelName.trim(),
      authEnvVar: form.authEnvVar.trim(),
      description: form.description.trim(),
      capabilities: form.capabilitiesText
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean),
      enabled: form.enabled,
    };

    try {
      if (editingId) {
        const res = await apiClient.updateCustomTool(editingId, payload);
        setCustomTools((prev) => prev.map((t) => (t.id === editingId ? res.tool : t)));
        setFeedback(`Updated custom tool "${res.tool.name}".`);
      } else {
        const res = await apiClient.createCustomTool(payload);
        setCustomTools((prev) => [res.tool, ...prev]);
        setFeedback(`Added custom tool "${res.tool.name}".`);
      }
      setShowBuilder(false);
      setEditingId(null);
      setForm(EMPTY_FORM);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save custom tool.');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleEnabled = async (tool: CustomToolRecord) => {
    setBusyId(tool.id);
    setError(null);
    try {
      const res = await apiClient.updateCustomTool(tool.id, { enabled: !tool.enabled });
      setCustomTools((prev) => prev.map((t) => (t.id === tool.id ? res.tool : t)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to toggle tool state.');
    } finally {
      setBusyId(null);
    }
  };

  const handleTestTool = async (tool: CustomToolRecord) => {
    setTestingId(tool.id);
    setError(null);
    setFeedback(null);
    try {
      const res = await apiClient.testCustomTool(tool.id);
      setCustomTools((prev) => prev.map((t) => (t.id === tool.id ? res.tool : t)));
      setFeedback(
        `${tool.name}: ${res.result.message} (${res.result.latencyMs}ms)${
          res.result.details && res.result.details.length > 0
            ? ` · Models: ${res.result.details.join(', ')}`
            : ''
        }`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection test failed.');
    } finally {
      setTestingId(null);
    }
  };

  const handleDeleteTool = async (tool: CustomToolRecord) => {
    setBusyId(tool.id);
    setError(null);
    setFeedback(null);
    try {
      await apiClient.deleteCustomTool(tool.id);
      setCustomTools((prev) => prev.filter((t) => t.id !== tool.id));
      setFeedback(`Deleted custom tool "${tool.name}".`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to delete tool.');
    } finally {
      setBusyId(null);
    }
  };

  const handleDownloadGuide = () => {
    const blob = new Blob([GUIDE_MARKDOWN], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'TOOLS_AND_INTEGRATIONS_GUIDE.md';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Tools & Agent Integrations
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Author your own custom HTTP APIs and local Ollama connectors, inspect built-in engines, and review integration architecture.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={loadTools}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 whitespace-nowrap"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveSection('custom');
              openCreateForm();
            }}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-xs font-medium whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Custom Tool</span>
          </button>
        </div>
      </div>

      {/* Section Switcher */}
      <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-200/70 rounded-lg w-fit">
        {(
          [
            ['custom', `User-Generated Tools (${customTools.length})`],
            ['builtin', `Built-In Engines (${tools.length})`],
            ['guide', 'Integration & Ollama Guide'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setActiveSection(id)}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              activeSection === id
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error && (
        <div role="alert" className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          {error}
        </div>
      )}
      {feedback && (
        <div className="p-3.5 rounded-lg bg-emerald-50 border border-emerald-200 text-sm text-emerald-800">
          {feedback}
        </div>
      )}

      {/* SECTION 1: USER-GENERATED TOOLS */}
      {activeSection === 'custom' && (
        <div className="space-y-6">
          {showBuilder && (
            <form
              onSubmit={handleSaveTool}
              className="bg-white border border-slate-200 rounded-xl p-6 space-y-5"
            >
              <div className="flex items-start justify-between gap-4 pb-4 border-b border-slate-200">
                <div>
                  <h2 className="text-base font-semibold text-slate-900">
                    {editingId ? 'Edit Custom Tool / API' : 'Define New Custom Tool / API'}
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Enabled HTTP Search & Webhook tools are automatically queried by the Researcher Agent during runs.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setShowBuilder(false);
                    setEditingId(null);
                  }}
                  aria-label="Close tool form"
                  className="p-1 text-slate-400 hover:text-slate-700"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {!editingId && (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-slate-500">Quick-fill template:</span>
                  {QUICK_TEMPLATES.map((tpl) => (
                    <button
                      key={tpl.label}
                      type="button"
                      onClick={() => setForm({ ...tpl.values })}
                      className="text-blue-700 hover:text-blue-900 underline underline-offset-2 whitespace-nowrap"
                    >
                      {tpl.label}
                    </button>
                  ))}
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="tool-name" className="block text-xs font-medium text-slate-700 mb-1">
                    Tool Name
                  </label>
                  <input
                    id="tool-name"
                    type="text"
                    required
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="e.g., ArXiv Preprint Search"
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300"
                  />
                </div>

                <div>
                  <label htmlFor="tool-type" className="block text-xs font-medium text-slate-700 mb-1">
                    Integration Type
                  </label>
                  <select
                    id="tool-type"
                    value={form.toolType}
                    onChange={(e) => {
                      const nextType = e.target.value as CustomToolType;
                      setForm({
                        ...form,
                        toolType: nextType,
                        httpMethod: nextType === 'ollama_model' ? 'POST' : form.httpMethod,
                      });
                    }}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 bg-white"
                  >
                    <option value="http_search">Custom HTTP Search API (auto-queried by Researcher)</option>
                    <option value="ollama_model">Local Ollama Model Connector</option>
                    <option value="webhook_tool">Custom Agent Webhook / Data API</option>
                    <option value="mcp_endpoint">External MCP / Tool Server</option>
                  </select>
                </div>

                <div className="md:col-span-2">
                  <label htmlFor="tool-url" className="block text-xs font-medium text-slate-700 mb-1">
                    Endpoint URL
                  </label>
                  <input
                    id="tool-url"
                    type="url"
                    required
                    value={form.endpointUrl}
                    onChange={(e) => setForm({ ...form, endpointUrl: e.target.value })}
                    placeholder={
                      form.toolType === 'ollama_model'
                        ? 'http://localhost:11434'
                        : 'https://export.arxiv.org/api/query?search_query=all:{{query}}'
                    }
                    className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300"
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    {form.toolType === 'ollama_model'
                      ? 'Base URL of your local or Docker Ollama instance (e.g., http://localhost:11434).'
                      : 'Include {{query}} in the URL for GET search endpoints, or use POST to send { "query": "..." }.'}
                  </p>
                </div>

                <div>
                  <label htmlFor="tool-category" className="block text-xs font-medium text-slate-700 mb-1">
                    Category
                  </label>
                  <input
                    id="tool-category"
                    type="text"
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                    placeholder="e.g., Academic Search, Local LLM, Domain API"
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300"
                  />
                </div>

                {form.toolType === 'ollama_model' ? (
                  <div>
                    <label htmlFor="tool-model" className="block text-xs font-medium text-slate-700 mb-1">
                      Ollama Model Tag
                    </label>
                    <input
                      id="tool-model"
                      type="text"
                      value={form.modelName}
                      onChange={(e) => setForm({ ...form, modelName: e.target.value })}
                      placeholder="e.g., llama3.1:8b or qwen2.5:14b"
                      className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300"
                    />
                  </div>
                ) : (
                  <div>
                    <label htmlFor="tool-method" className="block text-xs font-medium text-slate-700 mb-1">
                      HTTP Method
                    </label>
                    <select
                      id="tool-method"
                      value={form.httpMethod}
                      onChange={(e) =>
                        setForm({ ...form, httpMethod: e.target.value === 'POST' ? 'POST' : 'GET' })
                      }
                      className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 bg-white"
                    >
                      <option value="GET">GET</option>
                      <option value="POST">POST (sends JSON query payload)</option>
                    </select>
                  </div>
                )}

                <div className="md:col-span-2">
                  <label htmlFor="tool-desc" className="block text-xs font-medium text-slate-700 mb-1">
                    Description & Agent Usage Notes
                  </label>
                  <textarea
                    id="tool-desc"
                    rows={2}
                    required
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                    placeholder="Describe what data this endpoint returns and how research agents should use it."
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300"
                  />
                </div>

                <div>
                  <label htmlFor="tool-caps" className="block text-xs font-medium text-slate-700 mb-1">
                    Capabilities (comma-separated)
                  </label>
                  <input
                    id="tool-caps"
                    type="text"
                    value={form.capabilitiesText}
                    onChange={(e) => setForm({ ...form, capabilitiesText: e.target.value })}
                    placeholder="Preprint Search, XML Feed, Citations"
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300"
                  />
                </div>

                <div>
                  <label htmlFor="tool-env-ref" className="block text-xs font-medium text-slate-700 mb-1">
                    Server Auth Env Variable Name (Optional)
                  </label>
                  <input
                    id="tool-env-ref"
                    type="text"
                    value={form.authEnvVar}
                    onChange={(e) => setForm({ ...form, authEnvVar: e.target.value.toUpperCase() })}
                    placeholder="e.g., CUSTOM_SEARCH_TOKEN"
                    className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-300"
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    Reference only the variable name defined in your server .env — never enter raw secrets here.
                  </p>
                </div>
              </div>

              <div className="pt-3 border-t border-slate-200 flex items-center justify-between gap-4">
                <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                    className="h-4 w-4 rounded border-slate-300 text-blue-700"
                  />
                  <span>Enable tool immediately for research workflows</span>
                </label>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setShowBuilder(false);
                      setEditingId(null);
                    }}
                    className="px-3.5 py-2 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-60 text-white text-xs font-medium"
                  >
                    {saving ? 'Saving...' : editingId ? 'Save Changes' : 'Create Tool'}
                  </button>
                </div>
              </div>
            </form>
          )}

          {customTools.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl p-10 text-center space-y-4">
              <h2 className="text-base font-semibold text-slate-900">
                No User-Generated Tools Configured Yet
              </h2>
              <p className="text-sm text-slate-600 max-w-lg mx-auto">
                Write your own custom REST search connectors (ArXiv, Wikipedia, internal JSON APIs) or register a local Ollama model server right here.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
                <button
                  type="button"
                  onClick={() => openCreateForm()}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-xs font-medium"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Create Custom Tool</span>
                </button>
                {QUICK_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.label}
                    type="button"
                    onClick={() => openCreateForm(tpl.values)}
                    className="px-3.5 py-2 rounded-lg border border-slate-200 hover:bg-slate-50 text-xs font-medium text-slate-700"
                  >
                    Use {tpl.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {customTools.map((tool) => (
                <div
                  key={tool.id}
                  className="bg-white border border-slate-200 rounded-xl p-6 space-y-3.5 flex flex-col justify-between"
                >
                  <div className="space-y-2.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-xs text-slate-500">
                          {tool.category} · {TOOL_TYPE_LABELS[tool.toolType]}
                        </div>
                        <h2 className="text-base font-semibold text-slate-900 mt-0.5 truncate">
                          {tool.name}
                        </h2>
                      </div>
                      <button
                        type="button"
                        disabled={busyId === tool.id}
                        onClick={() => handleToggleEnabled(tool)}
                        className={`text-xs font-medium whitespace-nowrap shrink-0 underline underline-offset-2 ${
                          tool.enabled ? 'text-emerald-700' : 'text-slate-500'
                        }`}
                      >
                        {tool.enabled ? 'Enabled' : 'Disabled'}
                      </button>
                    </div>

                    <div className="text-xs font-mono text-slate-600 break-all">
                      {tool.toolType === 'ollama_model'
                        ? `Ollama · ${tool.modelName || 'default model'} @ ${tool.endpointUrl}`
                        : `${tool.httpMethod} ${tool.endpointUrl}`}
                    </div>

                    <p className="text-sm text-slate-600 leading-relaxed">{tool.description}</p>

                    <div className="text-xs text-slate-500">
                      Capabilities: {tool.capabilities.join(' · ')}
                      {tool.authEnvVar ? ` · Auth Env: ${tool.authEnvVar}` : ''}
                    </div>

                    {tool.lastTestMessage && (
                      <div
                        className={`text-xs ${
                          tool.lastTestStatus === 'ok' ? 'text-emerald-700' : 'text-amber-700'
                        }`}
                      >
                        Last test: {tool.lastTestMessage}
                      </div>
                    )}
                  </div>

                  <div className="pt-3 border-t border-slate-100 flex items-center justify-between gap-2">
                    <button
                      type="button"
                      disabled={testingId === tool.id}
                      onClick={() => handleTestTool(tool)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-xs font-medium text-slate-700 whitespace-nowrap"
                    >
                      <Play className="w-3 h-3" />
                      <span>{testingId === tool.id ? 'Testing...' : 'Test Connection'}</span>
                    </button>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => openEditForm(tool)}
                        aria-label={`Edit ${tool.name}`}
                        className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-100"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        disabled={busyId === tool.id}
                        onClick={() => handleDeleteTool(tool)}
                        aria-label={`Delete ${tool.name}`}
                        className="p-1.5 rounded-md text-slate-500 hover:text-red-600 hover:bg-red-50"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* SECTION 2: BUILT-IN ENGINES */}
      {activeSection === 'builtin' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {tools.map((tool) => (
            <div key={tool.id} className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-xs text-slate-500">{tool.category}</div>
                  <h2 className="text-base font-semibold text-slate-900 mt-0.5">{tool.name}</h2>
                </div>
                <div
                  className={`inline-flex items-center gap-1.5 text-xs font-medium shrink-0 ${
                    tool.configured ? 'text-emerald-700' : 'text-amber-700'
                  }`}
                >
                  {tool.configured ? (
                    <CheckCircle2 className="w-4 h-4" />
                  ) : (
                    <AlertCircle className="w-4 h-4" />
                  )}
                  <span>{tool.configured ? 'Configured' : 'Standby / Optional'}</span>
                </div>
              </div>

              <div className="text-xs font-mono text-slate-600">Engine: {tool.mode}</div>
              <p className="text-sm text-slate-600 leading-relaxed">{tool.description}</p>

              <div className="pt-2 border-t border-slate-100 text-xs text-slate-500">
                Capabilities: {tool.capabilities.join(' · ')}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* SECTION 3: INTEGRATION & OLLAMA BLUEPRINT */}
      {activeSection === 'guide' && (
        <div className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-slate-200">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">
                Integration Architecture & Local Ollama Setup
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Full reference also saved in repository at TOOLS_AND_INTEGRATIONS_GUIDE.md.
              </p>
            </div>
            <button
              type="button"
              onClick={handleDownloadGuide}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-200 hover:bg-slate-50 text-xs font-medium text-slate-700 whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download Guide (.md)</span>
            </button>
          </div>

          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-900">
              1. Which Agent Uses Which Integration
            </h3>
            <div className="overflow-x-auto border border-slate-200 rounded-lg">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                  <tr>
                    <th className="py-2.5 px-3 font-medium">Integration</th>
                    <th className="py-2.5 px-3 font-medium">Agent Consumer</th>
                    <th className="py-2.5 px-3 font-medium">Requirement</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-slate-700">
                  <tr>
                    <td className="py-2.5 px-3 font-medium">Gemini Reasoning / Ollama LLM</td>
                    <td className="py-2.5 px-3">All 10 structured agents + Follow-up Q&A</td>
                    <td className="py-2.5 px-3">Required (Gemini default, or local Ollama)</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 px-3 font-medium">User-Generated HTTP Search Tools</td>
                    <td className="py-2.5 px-3">Researcher Agent (parallel retrieval)</td>
                    <td className="py-2.5 px-3">Optional — authored directly in this page</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 px-3 font-medium">Tavily / Gemini Google Search</td>
                    <td className="py-2.5 px-3">Researcher Agent (live web discovery)</td>
                    <td className="py-2.5 px-3">Automatic via Gemini; Tavily optional</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 px-3 font-medium">Vector Embeddings + SQLite Store</td>
                    <td className="py-2.5 px-3">RAG Ingestion & Checkpoint Engine</td>
                    <td className="py-2.5 px-3">Built-in (zero manual setup)</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="space-y-2.5">
            <h3 className="text-sm font-semibold text-slate-900">
              2. Running the Backend Locally with Ollama
            </h3>
            <p className="text-sm text-slate-600 leading-relaxed">
              Orchestra AI natively supports Ollama when self-hosted on your machine or in Docker. Cloud preview sandboxes cannot reach localhost on your laptop directly, so run the server locally with these environment settings:
            </p>
            <pre className="p-4 rounded-lg bg-slate-900 text-slate-100 text-xs font-mono overflow-x-auto leading-relaxed">
{`# 1. Pull a structured-JSON reasoning model & local embedding model
ollama pull llama3.1:8b
ollama pull nomic-embed-text

# 2. Configure .env in your local checkout
LLM_PROVIDER="ollama"
OLLAMA_BASE_URL="http://localhost:11434"
OLLAMA_MODEL="llama3.1:8b"
OLLAMA_EMBED_MODEL="nomic-embed-text"

# 3. Start Orchestra AI locally
npm install && npm run dev`}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
