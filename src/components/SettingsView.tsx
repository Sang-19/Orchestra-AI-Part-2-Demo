import React, { useEffect, useState } from 'react';
import { Download, Save, Trash2 } from 'lucide-react';
import { apiClient } from '../services/apiClient';
import { GEMINI_MODEL_OPTIONS, type AgentModelRouting, type User, type UserSettings } from '../types/research';

interface SettingsViewProps {
  user: User;
  settings: UserSettings | null;
  onUserUpdated: (user: User) => void;
  onSettingsUpdated: (settings: UserSettings) => void;
  onHistoryCleared: () => Promise<void>;
}

export function SettingsView({
  user,
  settings,
  onUserUpdated,
  onSettingsUpdated,
  onHistoryCleared,
}: SettingsViewProps) {
  const [name, setName] = useState(user.name);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const [form, setForm] = useState<UserSettings>(
    settings ?? {
      userId: user.id,
      defaultMode: 'standard',
      maxRetries: 2,
      groundednessThreshold: 0.75,
      citationStyle: 'numeric',
      reportTone: 'executive',
      includeWebDefault: true,
      includeRagDefault: true,
      notifyOnComplete: true,
      notifyOnFailure: true,
      modelRouting: {
        planner: 'gemini-4-hydrogen', researcher: 'gemini-3.8-flash', evidenceExtractor: 'gemini-3.6-flash',
        factChecker: 'gemini-4-hydrogen', sourceCredibility: 'gemini-3.5-flash-lite', contradictionChecker: 'gemini-4-hydrogen',
        summarizer: 'gemini-3.1-flash-lite', writer: 'gemini-3.8-flash', groundednessChecker: 'gemini-4-hydrogen',
        qualityEvaluator: 'gemini-3.6-flash', searchGrounding: 'gemini-3.6-flash',
      },
      updatedAt: new Date().toISOString(),
    }
  );

  const [confirmClear, setConfirmClear] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (settings) setForm(settings);
  }, [settings]);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setFeedback(null);
    try {
      const res = await apiClient.updateProfile(name);
      onUserUpdated(res.user);
      setFeedback('Profile updated.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update profile.');
    } finally {
      setSaving(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setFeedback(null);
    try {
      await apiClient.changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setFeedback('Password updated securely.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to change password.');
    } finally {
      setSaving(false);
    }
  };

  const handleSavePreferences = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setFeedback(null);
    try {
      const res = await apiClient.updateSettings(form);
      onSettingsUpdated(res.settings);
      setFeedback('Research and notification preferences saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save settings.');
    } finally {
      setSaving(false);
    }
  };

  const handleExportJson = async () => {
    setError(null);
    try {
      const payload = await apiClient.exportAllData();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `orchestra-workspace-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setFeedback('Workspace archive exported as JSON.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed.');
    }
  };

  const handleClearHistory = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await apiClient.clearCompletedHistory();
      setConfirmClear(false);
      await onHistoryCleared();
      setFeedback(`Removed ${res.deletedCount} completed/archived research sessions.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear history.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-4xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Workspace Settings
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Manage your account profile, security credentials, multi-agent research defaults, and stored data.
        </p>
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

      {/* Profile + Security */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <form onSubmit={handleSaveProfile} className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <h2 className="text-base font-semibold text-slate-900">User Profile</h2>
          <div>
            <label htmlFor="profile-email" className="block text-xs font-medium text-slate-600 mb-1">
              Email Address
            </label>
            <input
              id="profile-email"
              type="email"
              disabled
              value={user.email}
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 bg-slate-50 text-slate-500"
            />
          </div>
          <div>
            <label htmlFor="profile-name" className="block text-xs font-medium text-slate-700 mb-1">
              Display Name
            </label>
            <input
              id="profile-name"
              type="text"
              required
              minLength={2}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300"
            />
          </div>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-medium"
          >
            <Save className="w-3.5 h-3.5" />
            <span>Save Profile</span>
          </button>
        </form>

        <form onSubmit={handleChangePassword} className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <h2 className="text-base font-semibold text-slate-900">Account Security</h2>
          <div>
            <label htmlFor="cur-pw" className="block text-xs font-medium text-slate-700 mb-1">
              Current Password
            </label>
            <input
              id="cur-pw"
              type="password"
              required
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300"
            />
          </div>
          <div>
            <label htmlFor="new-pw" className="block text-xs font-medium text-slate-700 mb-1">
              New Password (8+ characters)
            </label>
            <input
              id="new-pw"
              type="password"
              required
              minLength={8}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300"
            />
          </div>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-slate-300 hover:bg-slate-50 text-slate-800 text-xs font-medium"
          >
            <span>Update Password</span>
          </button>
        </form>
      </div>

      {/* Research & AI Configuration */}
      <form onSubmit={handleSavePreferences} className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <h2 className="text-base font-semibold text-slate-900">
          Research & Verification Defaults
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="pref-mode" className="block text-xs font-medium text-slate-700 mb-1">
              Default Research Mode
            </label>
            <select
              id="pref-mode"
              value={form.defaultMode}
              onChange={(e) =>
                setForm({ ...form, defaultMode: e.target.value as UserSettings['defaultMode'] })
              }
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 bg-white"
            >
              <option value="standard">Standard Synthesis</option>
              <option value="deep">Deep Multi-Cycle</option>
              <option value="document_focused">Document-Focused</option>
            </select>
          </div>

          <div>
            <label htmlFor="pref-tone" className="block text-xs font-medium text-slate-700 mb-1">
              Report Writing Tone
            </label>
            <select
              id="pref-tone"
              value={form.reportTone}
              onChange={(e) =>
                setForm({ ...form, reportTone: e.target.value as UserSettings['reportTone'] })
              }
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 bg-white"
            >
              <option value="executive">Executive Brief</option>
              <option value="academic">Academic Peer-Style</option>
              <option value="technical">Technical Engineering</option>
            </select>
          </div>

          <div>
            <label htmlFor="pref-retries" className="block text-xs font-medium text-slate-700 mb-1">
              Default Adaptive Retry Limit
            </label>
            <select
              id="pref-retries"
              value={form.maxRetries}
              onChange={(e) => setForm({ ...form, maxRetries: Number(e.target.value) })}
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 bg-white"
            >
              <option value={0}>0 retries</option>
              <option value={1}>1 retry</option>
              <option value={2}>2 retries</option>
              <option value={3}>3 retries</option>
            </select>
          </div>

          <div>
            <label htmlFor="pref-threshold" className="block text-xs font-medium text-slate-700 mb-1">
              Minimum Groundedness Threshold ({Math.round(form.groundednessThreshold * 100)}%)
            </label>
            <input
              id="pref-threshold"
              type="range"
              min={0.5}
              max={0.95}
              step={0.05}
              value={form.groundednessThreshold}
              onChange={(e) =>
                setForm({ ...form, groundednessThreshold: Number(e.target.value) })
              }
              className="w-full accent-blue-700 mt-2"
            />
          </div>
        </div>


        <div className="pt-5 border-t border-slate-100 space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Per-Agent Gemini Model Routing</h3>
            <p className="mt-1 text-xs text-slate-500">All Gemini agents share GEMINI_API_KEY. Choose a primary model for each role; quota-aware fallback models are tried automatically.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {([
              ['planner', 'Main Planner'], ['researcher', 'Research Agents'],
              ['evidenceExtractor', 'Evidence Extraction'], ['factChecker', 'Fact Checker'],
              ['sourceCredibility', 'Source Credibility'], ['contradictionChecker', 'Contradiction Checker'],
              ['summarizer', 'Summarizer'], ['writer', 'Writer Agent'],
              ['groundednessChecker', 'Groundedness Checker'], ['qualityEvaluator', 'Quality Evaluator'],
              ['searchGrounding', 'Google Search Grounding'],
            ] as Array<[keyof AgentModelRouting, string]>).map(([role, label]) => (
              <div key={role}>
                <label htmlFor={`model-${role}`} className="block text-xs font-medium text-slate-700 mb-1">{label}</label>
                <select
                  id={`model-${role}`}
                  value={form.modelRouting[role]}
                  onChange={(e) => setForm({ ...form, modelRouting: { ...form.modelRouting, [role]: e.target.value as AgentModelRouting[typeof role] } })}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 bg-white"
                >
                  {GEMINI_MODEL_OPTIONS.map((model) => <option key={model.value} value={model.value}>{model.label}</option>)}
                </select>
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-500">Fallbacks activate for quota, rate-limit, unavailable-model and server errors. Invalid request or schema errors remain visible.</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-slate-100">
          <label className="flex items-center gap-2.5 text-sm text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={form.includeWebDefault}
              onChange={(e) => setForm({ ...form, includeWebDefault: e.target.checked })}
              className="h-4 w-4 rounded border-slate-300 text-blue-700"
            />
            <span>Enable Live Web Search by default</span>
          </label>
          <label className="flex items-center gap-2.5 text-sm text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={form.includeRagDefault}
              onChange={(e) => setForm({ ...form, includeRagDefault: e.target.checked })}
              className="h-4 w-4 rounded border-slate-300 text-blue-700"
            />
            <span>Enable Private Knowledge Base RAG by default</span>
          </label>
          <label className="flex items-center gap-2.5 text-sm text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={form.notifyOnComplete}
              onChange={(e) => setForm({ ...form, notifyOnComplete: e.target.checked })}
              className="h-4 w-4 rounded border-slate-300 text-blue-700"
            />
            <span>Notify in UI when research completes</span>
          </label>
          <label className="flex items-center gap-2.5 text-sm text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={form.notifyOnFailure}
              onChange={(e) => setForm({ ...form, notifyOnFailure: e.target.checked })}
              className="h-4 w-4 rounded border-slate-300 text-blue-700"
            />
            <span>Notify in UI when execution fails or pauses</span>
          </label>
        </div>

        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-xs font-medium"
        >
          <Save className="w-3.5 h-3.5" />
          <span>Save Preferences</span>
        </button>
      </form>

      {/* Data Management */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <h2 className="text-base font-semibold text-slate-900">Data Management</h2>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleExportJson}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-slate-300 hover:bg-slate-50 text-xs font-medium text-slate-800"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export Workspace Archive (.json)</span>
          </button>

          {!confirmClear ? (
            <button
              type="button"
              onClick={() => setConfirmClear(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-red-200 text-red-700 hover:bg-red-50 text-xs font-medium"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Clear Completed History</span>
            </button>
          ) : (
            <div className="inline-flex items-center gap-2 p-2 rounded-lg bg-red-50 border border-red-200">
              <span className="text-xs text-red-800">Delete all finished research sessions?</span>
              <button
                type="button"
                onClick={handleClearHistory}
                className="px-2.5 py-1 rounded bg-red-600 text-white text-xs font-medium"
              >
                Confirm Delete
              </button>
              <button
                type="button"
                onClick={() => setConfirmClear(false)}
                className="px-2.5 py-1 text-xs text-slate-600"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
