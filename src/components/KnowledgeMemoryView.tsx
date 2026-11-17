import React, { useState } from 'react';
import {
  FolderPlus,
  Search,
  Trash2,
  Upload,
  FileText,
  Plus,
} from 'lucide-react';
import { apiClient } from '../services/apiClient';
import { StatusLabel } from './OverviewDashboard';
import type {
  CollectionRecord,
  DocumentRecord,
  ResearchSession,
  RetrievalMatch,
} from '../types/research';

interface KnowledgeMemoryViewProps {
  collections: CollectionRecord[];
  documents: DocumentRecord[];
  sessions: ResearchSession[];
  onRefreshData: () => Promise<void>;
  onOpenSession: (session: ResearchSession) => void;
}

export function KnowledgeMemoryView({
  collections,
  documents,
  sessions,
  onRefreshData,
  onOpenSession,
}: KnowledgeMemoryViewProps) {
  const [colName, setColName] = useState('');
  const [colDesc, setColDesc] = useState('');
  const [targetCollectionId, setTargetCollectionId] = useState<string>('');
  const [uploading, setUploading] = useState(false);

  const [noteTitle, setNoteTitle] = useState('');
  const [noteContent, setNoteContent] = useState('');
  const [showPasteModal, setShowPasteModal] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [matches, setMatches] = useState<RetrievalMatch[] | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleCreateCollection = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setFeedback(null);
    try {
      const res = await apiClient.createCollection(colName, colDesc);
      setColName('');
      setColDesc('');
      setTargetCollectionId(res.collection.id);
      setFeedback(`Created collection "${res.collection.name}".`);
      await onRefreshData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to create collection.');
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    setFeedback(null);
    try {
      const res = await apiClient.uploadDocument(file, targetCollectionId || null);
      setFeedback(
        res.document.status === 'duplicate'
          ? `Skipped duplicate file "${res.document.filename}".`
          : `Indexed "${res.document.filename}" (${res.document.chunkCount} ${res.document.chunkCount === 1 ? 'chunk' : 'chunks'}).`
      );
      await onRefreshData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'File upload failed.');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const handlePasteText = async (e: React.FormEvent) => {
    e.preventDefault();
    setUploading(true);
    setError(null);
    setFeedback(null);
    try {
      const res = await apiClient.ingestTextDocument({
        title: noteTitle,
        content: noteContent,
        collectionId: targetCollectionId || null,
      });
      setNoteTitle('');
      setNoteContent('');
      setShowPasteModal(false);
      setFeedback(`Indexed "${res.document.filename}" (${res.document.chunkCount} ${res.document.chunkCount === 1 ? 'chunk' : 'chunks'}).`);
      await onRefreshData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Text ingestion failed.');
    } finally {
      setUploading(false);
    }
  };

  const handleDeleteDocument = async (id: string) => {
    setError(null);
    try {
      await apiClient.deleteDocument(id);
      await onRefreshData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete document.');
    }
  };

  const handleDeleteCollection = async (id: string) => {
    setError(null);
    try {
      await apiClient.deleteCollection(id);
      if (targetCollectionId === id) setTargetCollectionId('');
      await onRefreshData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete collection.');
    }
  };

  const handleSemanticSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setSearching(true);
    setError(null);
    try {
      const res = await apiClient.semanticSearch({
        query: searchQuery,
        collectionIds: targetCollectionId ? [targetCollectionId] : undefined,
        topK: 5,
      });
      setMatches(res.matches);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Semantic search failed.');
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Knowledge Base & Persistent Memory
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Upload documents, organize collections, test semantic retrieval, and review archived research history. All vectors are isolated to your account.
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

      {/* Ingestion & Collections Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Upload / Ingest */}
        <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Document Ingestion</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Supports PDF, DOCX, Markdown, TXT, CSV, and JSON (up to 15 MB).
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowPasteModal((v) => !v)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-xs font-medium text-slate-700 whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{showPasteModal ? 'Hide Text Editor' : 'Paste Text Note'}</span>
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-end">
            <div>
              <label htmlFor="target-collection" className="block text-xs font-medium text-slate-700 mb-1.5">
                Target Collection (Optional)
              </label>
              <select
                id="target-collection"
                value={targetCollectionId}
                onChange={(e) => setTargetCollectionId(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 bg-white"
              >
                <option value="">Unassigned / Workspace Default</option>
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            <label className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-sm font-medium cursor-pointer transition-colors whitespace-nowrap">
              <Upload className="w-4 h-4" />
              <span>{uploading ? 'Indexing...' : 'Upload Document File'}</span>
              <input
                type="file"
                accept=".pdf,.docx,.txt,.md,.csv,.json"
                onChange={handleFileUpload}
                disabled={uploading}
                className="sr-only"
              />
            </label>
          </div>

          {showPasteModal && (
            <form onSubmit={handlePasteText} className="pt-4 border-t border-slate-200 space-y-3">
              <input
                type="text"
                required
                value={noteTitle}
                onChange={(e) => setNoteTitle(e.target.value)}
                placeholder="Note filename (e.g., q3_clinical_benchmark.md)"
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300"
              />
              <textarea
                rows={4}
                required
                value={noteContent}
                onChange={(e) => setNoteContent(e.target.value)}
                placeholder="Paste research notes, excerpts, or technical memos..."
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300"
              />
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={uploading}
                  className="px-4 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-medium"
                >
                  {uploading ? 'Embedding...' : 'Index Text Note'}
                </button>
              </div>
            </form>
          )}

          {/* Documents Table */}
          <div className="pt-2">
            <div className="text-xs font-semibold text-slate-700 mb-2">
              Indexed Files ({documents.length})
            </div>
            {documents.length === 0 ? (
              <div className="p-6 rounded-lg border border-dashed border-slate-200 text-center text-xs text-slate-500">
                No documents uploaded yet.
              </div>
            ) : (
              <div className="overflow-x-auto border border-slate-200 rounded-lg">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                    <tr>
                      <th className="py-2.5 px-3 font-medium">Document</th>
                      <th className="py-2.5 px-3 font-medium">Collection</th>
                      <th className="py-2.5 px-3 font-medium">Status</th>
                      <th className="py-2.5 px-3 font-medium text-right">Chunks</th>
                      <th className="py-2.5 px-3 font-medium text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {documents.map((doc) => (
                      <tr key={doc.id} className="hover:bg-slate-50">
                        <td className="py-2.5 px-3 font-medium text-slate-900 flex items-center gap-2">
                          <FileText className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                          <span className="truncate max-w-[200px]">{doc.filename}</span>
                        </td>
                        <td className="py-2.5 px-3 text-slate-600">
                          {doc.collectionName || 'Workspace Default'}
                        </td>
                        <td className="py-2.5 px-3 capitalize text-slate-700">{doc.status}</td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-700">
                          {doc.chunkCount}
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          <button
                            type="button"
                            onClick={() => handleDeleteDocument(doc.id)}
                            aria-label={`Delete ${doc.filename}`}
                            className="p-1 text-slate-400 hover:text-red-600"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Collections Panel */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <h2 className="text-base font-semibold text-slate-900">Collections</h2>
          <form onSubmit={handleCreateCollection} className="space-y-2.5">
            <input
              type="text"
              required
              value={colName}
              onChange={(e) => setColName(e.target.value)}
              placeholder="New collection name"
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300"
            />
            <input
              type="text"
              value={colDesc}
              onChange={(e) => setColDesc(e.target.value)}
              placeholder="Short description (optional)"
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300"
            />
            <button
              type="submit"
              className="w-full inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg border border-slate-300 hover:bg-slate-50 text-xs font-medium text-slate-800"
            >
              <FolderPlus className="w-3.5 h-3.5" />
              <span>Create Collection</span>
            </button>
          </form>

          <div className="divide-y divide-slate-100 border-t border-slate-200 pt-2">
            {collections.length === 0 ? (
              <p className="py-4 text-xs text-slate-500">No collections created yet.</p>
            ) : (
              collections.map((col) => (
                <div key={col.id} className="py-3 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-900 truncate">{col.name}</div>
                    <div className="text-xs text-slate-500 line-clamp-2">{col.description}</div>
                    <div className="text-xs font-mono text-slate-400 tabular-nums mt-0.5">
                      {col.documentCount} {col.documentCount === 1 ? 'indexed file' : 'indexed files'}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDeleteCollection(col.id)}
                    aria-label={`Delete collection ${col.name}`}
                    className="p-1 text-slate-400 hover:text-red-600 shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Semantic Retrieval Inspector */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Semantic Vector Retrieval</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Query your indexed document chunks by semantic similarity before launching a research run.
          </p>
        </div>

        <form onSubmit={handleSemanticSearch} className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              aria-label="Semantic search query"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search uploaded documents by concept or metric..."
              className="w-full pl-10 pr-4 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
          </div>
          <button
            type="submit"
            disabled={searching || !searchQuery.trim()}
            className="px-5 py-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white text-sm font-medium whitespace-nowrap"
          >
            {searching ? 'Searching...' : 'Search Knowledge Base'}
          </button>
        </form>

        {matches !== null && (
          <div className="space-y-2.5 pt-2">
            {matches.length === 0 ? (
              <div className="text-xs text-slate-500">No matching document chunks found.</div>
            ) : (
              matches.map((m) => (
                <div key={m.chunkId} className="p-4 rounded-lg border border-slate-200 bg-slate-50/50">
                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <span className="font-medium text-slate-800">
                      {m.filename} · Chunk #{m.chunkIndex + 1}
                    </span>
                    <span className="font-mono tabular-nums text-blue-700">
                      Similarity {Math.round(m.score * 100)}%
                    </span>
                  </div>
                  <p className="mt-1.5 text-xs text-slate-700 leading-relaxed">{m.content}</p>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Archived Research History */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200">
          <h2 className="text-base font-semibold text-slate-900">
            Stored Research History ({sessions.length})
          </h2>
        </div>
        {sessions.length === 0 ? (
          <div className="p-6 text-sm text-slate-500">No research history recorded yet.</div>
        ) : (
          <div className="divide-y divide-slate-100">
            {sessions.map((s) => (
              <div
                key={s.id}
                className="px-6 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 hover:bg-slate-50"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-900 truncate">{s.question}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <StatusLabel status={s.status} />
                    <span aria-hidden="true">·</span>
                    <span>{new Date(s.createdAt).toLocaleString()}</span>
                    <span aria-hidden="true">·</span>
                    <span className="tabular-nums">
                      {s.checkpoint?.claims.length ?? 0} claims
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onOpenSession(s)}
                  className="px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-100 text-xs font-medium text-slate-700 whitespace-nowrap shrink-0"
                >
                  Open Session
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
