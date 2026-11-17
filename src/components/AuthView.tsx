import React, { useState } from 'react';
import { ArrowRight, KeyRound, ShieldCheck, Layers } from 'lucide-react';
import { apiClient } from '../services/apiClient';
import type { User } from '../types/research';

interface AuthViewProps {
  onAuthenticated: (user: User) => void;
}

export function AuthView({ onAuthenticated }: AuthViewProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (mode === 'login') {
        const res = await apiClient.login({ email, password });
        onAuthenticated(res.user);
      } else {
        const res = await apiClient.register({ name, email, password });
        onAuthenticated(res.user);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed.');
    } finally {
      setLoading(false);
    }
  };

  const fillDemoCredentials = () => {
    setMode('login');
    setEmail('researcher@orchestra.ai');
    setPassword('Orchestra2026!');
    setError(null);
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col lg:flex-row">
      {/* Left Context Panel */}
      <div className="lg:w-1/2 bg-slate-900 text-slate-100 p-8 lg:p-16 flex flex-col justify-between">
        <div>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-md bg-blue-600 flex items-center justify-center">
              <Layers className="w-4 h-4 text-white" />
            </div>
            <span className="text-lg font-semibold tracking-tight text-white">Orchestra AI</span>
          </div>

          <div className="mt-14 max-w-lg">
            <h1 className="text-3xl lg:text-4xl font-semibold tracking-tight text-white leading-tight">
              Evidence-first multi-agent research orchestration.
            </h1>
            <p className="mt-4 text-slate-300 text-base leading-relaxed">
              Investigate complex topics with coordinated planning, parallel web and private document retrieval, claim-level fact checking, contradiction preservation, and strict groundedness validation.
            </p>
          </div>
        </div>

        <div className="mt-12 grid grid-cols-1 sm:grid-cols-2 gap-6 border-t border-slate-800 pt-8">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-white">
              <ShieldCheck className="w-4 h-4 text-blue-400" />
              <span>Traceable Verification</span>
            </div>
            <p className="mt-1.5 text-xs text-slate-400 leading-relaxed">
              Every claim retains its source passage, credibility grade, and explicit contradiction status.
            </p>
          </div>
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-white">
              <KeyRound className="w-4 h-4 text-blue-400" />
              <span>Isolated Knowledge Bases</span>
            </div>
            <p className="mt-1.5 text-xs text-slate-400 leading-relaxed">
              Uploaded PDF, DOCX, and Markdown documents are chunked and scoped strictly to your workspace.
            </p>
          </div>
        </div>
      </div>

      {/* Right Auth Form */}
      <div className="lg:w-1/2 flex items-center justify-center p-6 sm:p-12">
        <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl p-8">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg mb-6">
            <button
              type="button"
              onClick={() => {
                setMode('login');
                setError(null);
              }}
              className={`flex-1 py-2 px-3 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
                mode === 'login'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('register');
                setError(null);
              }}
              className={`flex-1 py-2 px-3 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
                mode === 'register'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Create Account
            </button>
          </div>

          <h2 className="text-xl font-semibold text-slate-900">
            {mode === 'login' ? 'Sign in to your workspace' : 'Create researcher account'}
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            {mode === 'login'
              ? 'Access your saved research reports, checkpoints, and knowledge collections.'
              : 'All sessions and uploaded documents remain isolated to your account.'}
          </p>

          {error && (
            <div
              role="alert"
              className="mt-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700"
            >
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            {mode === 'register' && (
              <div>
                <label htmlFor="auth-name" className="block text-sm font-medium text-slate-700 mb-1.5">
                  Full Name
                </label>
                <input
                  id="auth-name"
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Dr. Alex Rivera"
                  className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
                />
              </div>
            )}

            <div>
              <label htmlFor="auth-email" className="block text-sm font-medium text-slate-700 mb-1.5">
                Email Address
              </label>
              <input
                id="auth-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="researcher@orchestra.ai"
                className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              />
            </div>

            <div>
              <label htmlFor="auth-password" className="block text-sm font-medium text-slate-700 mb-1.5">
                Password
              </label>
              <input
                id="auth-password"
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Minimum 8 characters"
                className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 px-4 rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-60 text-white text-sm font-medium flex items-center justify-center gap-2 transition-colors whitespace-nowrap"
            >
              <span>{loading ? 'Authenticating...' : mode === 'login' ? 'Sign In' : 'Create Account'}</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </form>

          <div className="mt-6 pt-5 border-t border-slate-200 flex items-center justify-between gap-4">
            <span className="text-xs text-slate-500">
              Sample workspace: <span className="font-mono text-slate-700">researcher@orchestra.ai</span>
            </span>
            <button
              type="button"
              onClick={fillDemoCredentials}
              className="text-xs font-medium text-blue-700 hover:text-blue-900 underline underline-offset-2 whitespace-nowrap shrink-0"
            >
              Fill Demo Credentials
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
