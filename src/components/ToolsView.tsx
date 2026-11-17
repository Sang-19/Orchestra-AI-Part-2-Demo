import React, { useEffect, useState } from 'react';
import { CheckCircle2, AlertCircle, RefreshCw } from 'lucide-react';
import { apiClient } from '../services/apiClient';
import type { ToolStatus } from '../types/research';

export function ToolsView() {
  const [tools, setTools] = useState<ToolStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadTools = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.getToolsStatus();
      setTools(res.tools);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to fetch integration status.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTools();
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Tools & Agent Integrations
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Live server-verified status of AI models, search connectors, vector stores, and document ETL pipelines.
          </p>
        </div>
        <button
          type="button"
          onClick={loadTools}
          disabled={loading}
          className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 whitespace-nowrap shrink-0"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>Refresh Status</span>
        </button>
      </div>

      {error && (
        <div role="alert" className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          {error}
        </div>
      )}

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
    </div>
  );
}
