import crypto from 'node:crypto';
import express, { type Response } from 'express';
import multer from 'multer';
import { getDb } from '../db/database';
import {
  clearAuthCookie,
  createRateLimiter,
  extractTokenFromRequest,
  hashPassword,
  requireAuth,
  setAuthCookie,
  signAuthToken,
  verifyPassword,
  type AuthenticatedRequest,
} from '../auth/authMiddleware';
import {
  ingestDocument,
  MAX_UPLOAD_BYTES,
  semanticSearch,
} from '../rag/documentProcessor';
import {
  approveResearchPlan,
  createAndPlanResearch,
  deleteResearchSessionAndThread,
  getResearchSession,
  getUserSettings,
  mapSessionRow,
  rejectResearchPlan,
  resumeResearchExecution,
  pauseResearchExecution,
  stopResearchExecution,
  sessionBus,
} from '../orchestrator/workflowEngine';
import { getGeminiClient, hasGeminiKey, withExponentialBackoff } from '../ai/geminiClient';
import { normalizeModelRouting } from '../ai/modelRouter';
import { getOllamaConfig, isOllamaProviderEnabled } from '../ai/ollamaClient';
import { hasTavilyKey } from '../orchestrator/webSearch';
import {
  createCustomTool,
  deleteCustomTool,
  listCustomTools,
  testCustomToolConnection,
  updateCustomTool,
  type CustomToolInput,
} from '../tools/customTools';
import type {
  CollectionRecord,
  UserSettings,
  DashboardStats,
  DocumentRecord,
  ExecutionEvent,
  ResearchPlan,
  SessionMessage,
  ToolStatus,
} from '../../src/types/research';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

const authLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 30, keyPrefix: 'auth' });
const researchLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 20,
  keyPrefix: 'research',
});

export function createApiRouter(): express.Router {
  const router = express.Router();

  router.get('/health', (_req, res) => {
    try {
      const db = getDb();
      db.prepare('SELECT 1').get();
      res.json({ status: 'ok', database: 'connected', timestamp: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({
        status: 'error',
        error: err instanceof Error ? err.message : 'Database health check failed',
      });
    }
  });

  // ---------------- AUTHENTICATION ----------------

  router.post('/auth/register', authLimiter, (req, res) => {
    const { email, name, password } = req.body as {
      email?: string;
      name?: string;
      password?: string;
    };

    const cleanEmail = (email ?? '').trim().toLowerCase();
    const cleanName = (name ?? '').trim();
    const cleanPassword = password ?? '';

    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      res.status(400).json({ error: 'Please provide a valid email address.' });
      return;
    }
    if (cleanName.length < 2) {
      res.status(400).json({ error: 'Name must be at least 2 characters.' });
      return;
    }
    if (cleanPassword.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters.' });
      return;
    }

    const db = getDb();
    const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(cleanEmail);
    if (existing) {
      res.status(409).json({ error: 'An account with this email already exists.' });
      return;
    }

    const userId = `usr-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const passwordHash = hashPassword(cleanPassword);

    db.prepare(`
      INSERT INTO users (id, email, name, password_hash, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'researcher', ?, ?)
    `).run(userId, cleanEmail, cleanName, passwordHash, now, now);

    db.prepare(`INSERT INTO user_settings (user_id, updated_at) VALUES (?, ?)`).run(userId, now);

    const user = { id: userId, email: cleanEmail, name: cleanName, role: 'researcher', createdAt: now };
    const token = signAuthToken(user);
    setAuthCookie(res, token);

    res.status(201).json({ user, token });
  });

  router.post('/auth/login', authLimiter, (req, res) => {
    const { email, password } = req.body as { email?: string; password?: string };
    const cleanEmail = (email ?? '').trim().toLowerCase();
    const cleanPassword = password ?? '';

    if (!cleanEmail || !cleanPassword) {
      res.status(400).json({ error: 'Email and password are required.' });
      return;
    }

    const db = getDb();
    const row = db
      .prepare(`SELECT id, email, name, password_hash, role, created_at FROM users WHERE email = ?`)
      .get(cleanEmail) as
      | {
          id: string;
          email: string;
          name: string;
          password_hash: string;
          role: string;
          created_at: string;
        }
      | undefined;

    if (!row || !verifyPassword(cleanPassword, row.password_hash)) {
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }

    const user = {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      createdAt: row.created_at,
    };
    const token = signAuthToken(user);
    setAuthCookie(res, token);

    res.json({ user, token });
  });

  router.post('/auth/logout', (_req, res) => {
    clearAuthCookie(res);
    res.json({ ok: true });
  });

  router.get('/auth/session', (req, res) => {
    const token = extractTokenFromRequest(req);
    if (!token) {
      res.json({ user: null });
      return;
    }
    requireAuth(req as AuthenticatedRequest, res, () => {
      res.json({ user: (req as AuthenticatedRequest).user ?? null });
    });
  });

  router.get('/auth/me', requireAuth, (req: AuthenticatedRequest, res) => {
    res.json({ user: req.user });
  });

  router.patch('/auth/profile', requireAuth, (req: AuthenticatedRequest, res) => {
    const { name } = req.body as { name?: string };
    const cleanName = (name ?? '').trim();
    if (cleanName.length < 2) {
      res.status(400).json({ error: 'Display name must be at least 2 characters.' });
      return;
    }

    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(`UPDATE users SET name = ?, updated_at = ? WHERE id = ?`).run(
      cleanName,
      now,
      req.user!.id
    );

    res.json({ user: { ...req.user!, name: cleanName } });
  });

  router.post('/auth/change-password', requireAuth, (req: AuthenticatedRequest, res) => {
    const { currentPassword, newPassword } = req.body as {
      currentPassword?: string;
      newPassword?: string;
    };
    if (!currentPassword || !newPassword || newPassword.length < 8) {
      res.status(400).json({ error: 'Current password and an 8+ character new password are required.' });
      return;
    }

    const db = getDb();
    const row = db
      .prepare(`SELECT password_hash FROM users WHERE id = ?`)
      .get(req.user!.id) as { password_hash: string };

    if (!verifyPassword(currentPassword, row.password_hash)) {
      res.status(401).json({ error: 'Current password is incorrect.' });
      return;
    }

    db.prepare(`UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`).run(
      hashPassword(newPassword),
      new Date().toISOString(),
      req.user!.id
    );

    res.json({ ok: true });
  });

  // ---------------- DASHBOARD & TOOLS ----------------

  router.get('/dashboard/stats', requireAuth, (req: AuthenticatedRequest, res) => {
    const db = getDb();
    const userId = req.user!.id;

    const sessions = db
      .prepare(`SELECT status, groundedness_json, checkpoint_json FROM research_sessions WHERE user_id = ?`)
      .all(userId) as Array<{
      status: string;
      groundedness_json: string | null;
      checkpoint_json: string | null;
    }>;

    let completedSessions = 0;
    let activeSessions = 0;
    let failedSessions = 0;
    let awaitingApprovalSessions = 0;
    let totalClaimsVerified = 0;
    let groundednessSum = 0;
    let groundednessCount = 0;

    for (const s of sessions) {
      if (s.status === 'completed' || s.status === 'completed_with_warnings') completedSessions++;
      else if (s.status === 'running' || s.status === 'planning' || s.status === 'paused') activeSessions++;
      else if (s.status === 'failed' || s.status === 'rejected') failedSessions++;
      else if (s.status === 'awaiting_approval') awaitingApprovalSessions++;

      if (s.groundedness_json) {
        const g = JSON.parse(s.groundedness_json) as { score?: number };
        if (typeof g.score === 'number') {
          groundednessSum += g.score;
          groundednessCount++;
        }
      }
      if (s.checkpoint_json) {
        const cp = JSON.parse(s.checkpoint_json) as { claims?: unknown[] };
        totalClaimsVerified += cp.claims?.length ?? 0;
      }
    }

    const docStats = db
      .prepare(
        `SELECT COUNT(*) as totalDocs, COALESCE(SUM(chunk_count), 0) as totalChunks FROM documents WHERE user_id = ? AND status = 'indexed'`
      )
      .get(userId) as { totalDocs: number; totalChunks: number };

    const colStats = db
      .prepare(`SELECT COUNT(*) as totalCollections FROM collections WHERE user_id = ?`)
      .get(userId) as { totalCollections: number };

    const stats: DashboardStats = {
      totalSessions: sessions.length,
      completedSessions,
      activeSessions,
      failedSessions,
      awaitingApprovalSessions,
      totalDocuments: docStats.totalDocs,
      totalChunks: docStats.totalChunks,
      totalCollections: colStats.totalCollections,
      totalClaimsVerified,
      averageGroundedness:
        groundednessCount > 0 ? Number((groundednessSum / groundednessCount).toFixed(2)) : null,
    };

    res.json({ stats });
  });

  router.get('/tools/status', requireAuth, (req: AuthenticatedRequest, res) => {
    const geminiConfigured = hasGeminiKey();
    const tavilyConfigured = hasTavilyKey();
    const ollamaEnabled = isOllamaProviderEnabled();
    const ollamaCfg = getOllamaConfig();

    const tools: ToolStatus[] = [
      {
        id: 'gemini-reasoning',
        name: 'Google Gemini Reasoning Engine',
        category: 'LLM Orchestration',
        configured: geminiConfigured,
        mode: ollamaEnabled ? 'Standby (LLM_PROVIDER=ollama)' : 'Per-agent Gemini model routing',
        description:
          'Powers structured planning, evidence extraction, fact checking, contradiction detection, synthesis, and groundedness validation.',
        capabilities: ['Structured JSON Schemas', 'ThinkingLevel Control', 'Report Synthesis'],
      },
      {
        id: 'ollama-local-llm',
        name: 'Ollama Local Model Backend',
        category: 'Local LLM Orchestration',
        configured: ollamaEnabled || process.env.EMBEDDING_PROVIDER?.trim().toLowerCase() === 'ollama',
        mode: ollamaEnabled
          ? `${ollamaCfg.model} @ ${ollamaCfg.baseUrl}`
          : process.env.EMBEDDING_PROVIDER?.trim().toLowerCase() === 'ollama'
            ? `Local embeddings: ${ollamaCfg.embedModel} @ ${ollamaCfg.baseUrl}`
            : `Optional (set LLM_PROVIDER=ollama or EMBEDDING_PROVIDER=ollama in .env)`,
        description:
          'Runs Orchestra AI agents and embeddings against self-hosted local models via Ollama (/api/chat + /api/embed) when self-hosting locally or via Docker.',
        capabilities: ['Offline Local Inference', 'JSON Format Mode', 'Local Embeddings'],
      },
      {
        id: 'gemini-embeddings',
        name: 'Vector Embeddings Engine',
        category: 'Knowledge Retrieval',
        configured: geminiConfigured || ollamaEnabled,
        mode: ollamaEnabled
          ? `ollama:${ollamaCfg.embedModel}`
          : geminiConfigured
            ? 'gemini-embedding-2'
            : 'deterministic-v1 fallback',
        description:
          'Generates dense semantic embeddings for uploaded knowledge base documents and query similarity scoring.',
        capabilities: ['Semantic Chunk Indexing', 'Top-K Cosine Retrieval', 'Cross-Format RAG'],
      },
      {
        id: 'tavily-search',
        name: 'Tavily Web Search API',
        category: 'Live Web Discovery',
        configured: tavilyConfigured,
        mode: tavilyConfigured ? 'Tavily Advanced Search' : 'Optional (Gemini Grounding Active)',
        description:
          'Deep web search connector optimized for factual snippets, source URLs, and publication dates.',
        capabilities: ['Advanced Depth Search', 'Source Metadata Extraction', 'Date Attribution'],
      },
      {
        id: 'gemini-search-grounding',
        name: 'Gemini Google Search Grounding',
        category: 'Live Web Discovery',
        configured: geminiConfigured,
        mode: 'googleSearch Grounding Tool',
        description:
          'Built-in Google Search grounding returning live web groundingChunks and verified citation URIs.',
        capabilities: ['Live Web Citations', 'Automatic Grounding Fallback', 'URI Extraction'],
      },
      {
        id: 'langgraph-orchestrator',
        name: 'LangGraph StateGraph Orchestrator',
        category: 'Multi-Agent Workflow',
        configured: true,
        mode: 'StateGraph + Send() + Command + interrupt()',
        description:
          'Central LangGraph state machine coordinating parallel subtopic Send() fan-out, interrupt-based human approval, conditional retries, and ToolNode dispatch.',
        capabilities: ['Parallel Send() Branches', 'Interrupt Human Approval', 'Conditional Command Routing'],
      },
      {
        id: 'sqlite-store',
        name: 'SQLite LangGraph Checkpointer & Vector Store',
        category: 'Persistence & Memory',
        configured: true,
        mode: 'WAL Mode Durable Checkpointer',
        description:
          'Persists LangGraph thread checkpoints separately from user-isolated RAG document vectors, surviving backend restarts cleanly.',
        capabilities: ['LangGraph Thread Persistence', 'User Thread Isolation', 'Restart Recovery'],
      },
      {
        id: 'doc-parsers',
        name: 'Document Ingestion Pipeline',
        category: 'RAG ETL',
        configured: true,
        mode: 'PDF / DOCX / MD / TXT / CSV',
        description:
          'Extracts, cleans, hashes for duplicate detection, and chunks uploaded files with configurable overlap.',
        capabilities: ['unpdf Extraction', 'mammoth DOCX Parser', 'SHA-256 Deduplication'],
      },
    ];

    const customTools = listCustomTools(req.user!.id);
    res.json({ tools, customTools });
  });

  router.get('/tools/custom', requireAuth, (req: AuthenticatedRequest, res) => {
    res.json({ customTools: listCustomTools(req.user!.id) });
  });

  router.post('/tools/custom', requireAuth, (req: AuthenticatedRequest, res) => {
    try {
      const body = req.body as CustomToolInput;
      const tool = createCustomTool(req.user!.id, body);
      res.status(201).json({ tool });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to create custom tool.',
      });
    }
  });

  router.put('/tools/custom/:id', requireAuth, (req: AuthenticatedRequest, res) => {
    try {
      const tool = updateCustomTool(
        String(req.params.id),
        req.user!.id,
        req.body as Partial<CustomToolInput>
      );
      res.json({ tool });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to update custom tool.';
      res.status(msg.includes('not found') ? 404 : 400).json({ error: msg });
    }
  });

  router.delete('/tools/custom/:id', requireAuth, (req: AuthenticatedRequest, res) => {
    const removed = deleteCustomTool(String(req.params.id), req.user!.id);
    if (!removed) {
      res.status(404).json({ error: 'Custom tool not found.' });
      return;
    }
    res.json({ ok: true });
  });

  router.post('/tools/custom/:id/test', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const outcome = await testCustomToolConnection(String(req.params.id), req.user!.id);
      res.json(outcome);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Connection test failed.';
      res.status(msg.includes('not found') ? 404 : 400).json({ error: msg });
    }
  });

  // ---------------- SETTINGS & DATA ----------------

  router.get('/settings', requireAuth, (req: AuthenticatedRequest, res) => {
    res.json({ settings: getUserSettings(req.user!.id) });
  });

  router.put('/settings', requireAuth, (req: AuthenticatedRequest, res) => {
    const body = req.body as Partial<{
      defaultMode: 'standard' | 'deep' | 'document_focused';
      maxRetries: number;
      groundednessThreshold: number;
      citationStyle: 'numeric' | 'apa' | 'ieee';
      reportTone: 'academic' | 'executive' | 'technical';
      includeWebDefault: boolean;
      includeRagDefault: boolean;
      notifyOnComplete: boolean;
      notifyOnFailure: boolean;
      modelRouting: UserSettings['modelRouting'];
    }>;

    const current = getUserSettings(req.user!.id);
    const updated = {
      defaultMode: body.defaultMode ?? current.defaultMode,
      maxRetries: Math.min(4, Math.max(0, Number(body.maxRetries ?? current.maxRetries))),
      groundednessThreshold: Math.min(
        0.98,
        Math.max(0.4, Number(body.groundednessThreshold ?? current.groundednessThreshold))
      ),
      citationStyle: body.citationStyle ?? current.citationStyle,
      reportTone: body.reportTone ?? current.reportTone,
      includeWebDefault: body.includeWebDefault ?? current.includeWebDefault,
      includeRagDefault: body.includeRagDefault ?? current.includeRagDefault,
      notifyOnComplete: body.notifyOnComplete ?? current.notifyOnComplete,
      notifyOnFailure: body.notifyOnFailure ?? current.notifyOnFailure,
      modelRouting: normalizeModelRouting(body.modelRouting, current.modelRouting),
    };

    const now = new Date().toISOString();
    const db = getDb();
    db.prepare(`
      UPDATE user_settings
      SET default_mode = ?, max_retries = ?, groundedness_threshold = ?, citation_style = ?,
          report_tone = ?, include_web_default = ?, include_rag_default = ?,
          notify_on_complete = ?, notify_on_failure = ?, model_routing_json = ?, updated_at = ?
      WHERE user_id = ?
    `).run(
      updated.defaultMode,
      updated.maxRetries,
      updated.groundednessThreshold,
      updated.citationStyle,
      updated.reportTone,
      updated.includeWebDefault ? 1 : 0,
      updated.includeRagDefault ? 1 : 0,
      updated.notifyOnComplete ? 1 : 0,
      updated.notifyOnFailure ? 1 : 0,
      JSON.stringify(updated.modelRouting),
      now,
      req.user!.id
    );

    res.json({ settings: getUserSettings(req.user!.id) });
  });

  router.get('/data/export', requireAuth, (req: AuthenticatedRequest, res) => {
    const db = getDb();
    const userId = req.user!.id;
    const sessions = db
      .prepare(`SELECT * FROM research_sessions WHERE user_id = ? ORDER BY created_at DESC`)
      .all(userId) as Array<Record<string, unknown>>;
    const collections = db
      .prepare(`SELECT * FROM collections WHERE user_id = ?`)
      .all(userId);
    const documents = db
      .prepare(`SELECT id, filename, mime_type, file_size, status, chunk_count, created_at FROM documents WHERE user_id = ?`)
      .all(userId);

    res.json({
      exportedAt: new Date().toISOString(),
      user: req.user,
      settings: getUserSettings(userId),
      collections,
      documents,
      researchSessions: sessions.map(mapSessionRow),
    });
  });

  router.delete('/data/history', requireAuth, (req: AuthenticatedRequest, res) => {
    const db = getDb();
    const info = db
      .prepare(
        `DELETE FROM research_sessions WHERE user_id = ? AND status IN ('completed', 'completed_with_warnings', 'failed', 'rejected')`
      )
      .run(req.user!.id);
    res.json({ deletedCount: info.changes });
  });

  // ---------------- COLLECTIONS & RAG DOCUMENTS ----------------

  router.get('/collections', requireAuth, (req: AuthenticatedRequest, res) => {
    const db = getDb();
    const rows = db
      .prepare(
        `
        SELECT c.*, COUNT(d.id) as document_count
        FROM collections c
        LEFT JOIN documents d ON d.collection_id = c.id AND d.status = 'indexed'
        WHERE c.user_id = ?
        GROUP BY c.id
        ORDER BY c.created_at DESC
      `
      )
      .all(req.user!.id) as Array<{
      id: string;
      user_id: string;
      name: string;
      description: string;
      document_count: number;
      created_at: string;
    }>;

    const collections: CollectionRecord[] = rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      name: r.name,
      description: r.description,
      documentCount: r.document_count,
      createdAt: r.created_at,
    }));

    res.json({ collections });
  });

  router.post('/collections', requireAuth, (req: AuthenticatedRequest, res) => {
    const { name, description } = req.body as { name?: string; description?: string };
    const cleanName = (name ?? '').trim();
    if (cleanName.length < 2) {
      res.status(400).json({ error: 'Collection name must be at least 2 characters.' });
      return;
    }

    const id = `col-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const db = getDb();
    db.prepare(
      `INSERT INTO collections (id, user_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)`
    ).run(id, req.user!.id, cleanName, (description ?? '').trim(), now);

    res.status(201).json({
      collection: {
        id,
        userId: req.user!.id,
        name: cleanName,
        description: (description ?? '').trim(),
        documentCount: 0,
        createdAt: now,
      },
    });
  });

  router.delete('/collections/:id', requireAuth, (req: AuthenticatedRequest, res) => {
    const db = getDb();
    const info = db
      .prepare(`DELETE FROM collections WHERE id = ? AND user_id = ?`)
      .run(req.params.id, req.user!.id);
    if (info.changes === 0) {
      res.status(404).json({ error: 'Collection not found.' });
      return;
    }
    res.json({ ok: true });
  });

  router.get('/documents', requireAuth, (req: AuthenticatedRequest, res) => {
    const db = getDb();
    const rows = db
      .prepare(
        `
        SELECT d.*, c.name as collection_name
        FROM documents d
        LEFT JOIN collections c ON c.id = d.collection_id
        WHERE d.user_id = ?
        ORDER BY d.created_at DESC
      `
      )
      .all(req.user!.id) as Array<{
      id: string;
      user_id: string;
      collection_id: string | null;
      collection_name: string | null;
      filename: string;
      mime_type: string;
      file_size: number;
      status: DocumentRecord['status'];
      chunk_count: number;
      char_count: number;
      error_message: string | null;
      created_at: string;
    }>;

    const documents: DocumentRecord[] = rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      collectionId: r.collection_id,
      collectionName: r.collection_name,
      filename: r.filename,
      mimeType: r.mime_type,
      fileSize: r.file_size,
      status: r.status,
      chunkCount: r.chunk_count,
      charCount: r.char_count,
      errorMessage: r.error_message,
      createdAt: r.created_at,
    }));

    res.json({ documents });
  });

  router.post(
    '/documents/upload',
    requireAuth,
    upload.single('file'),
    async (req: AuthenticatedRequest, res) => {
      try {
        if (!req.file) {
          res.status(400).json({ error: 'No file attached.' });
          return;
        }
        const collectionId =
          typeof req.body?.collectionId === 'string' && req.body.collectionId.trim()
            ? req.body.collectionId.trim()
            : null;

        const doc = await ingestDocument({
          userId: req.user!.id,
          collectionId,
          filename: req.file.originalname,
          mimeType: req.file.mimetype,
          buffer: req.file.buffer,
        });

        res.status(201).json({ document: doc });
      } catch (err) {
        res.status(400).json({
          error: err instanceof Error ? err.message : 'Document ingestion failed.',
        });
      }
    }
  );

  router.post('/documents/text', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { title, content, collectionId } = req.body as {
        title?: string;
        content?: string;
        collectionId?: string;
      };
      const cleanTitle = (title ?? '').trim() || `note_${Date.now()}.md`;
      const cleanContent = (content ?? '').trim();
      if (cleanContent.length < 20) {
        res.status(400).json({ error: 'Document text must be at least 20 characters.' });
        return;
      }

      const filename = cleanTitle.endsWith('.md') || cleanTitle.endsWith('.txt')
        ? cleanTitle
        : `${cleanTitle}.md`;

      const doc = await ingestDocument({
        userId: req.user!.id,
        collectionId: collectionId?.trim() || null,
        filename,
        mimeType: 'text/markdown',
        buffer: Buffer.from(cleanContent, 'utf8'),
      });

      res.status(201).json({ document: doc });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Text ingestion failed.',
      });
    }
  });

  router.delete('/documents/:id', requireAuth, (req: AuthenticatedRequest, res) => {
    const db = getDb();
    const info = db
      .prepare(`DELETE FROM documents WHERE id = ? AND user_id = ?`)
      .run(req.params.id, req.user!.id);
    if (info.changes === 0) {
      res.status(404).json({ error: 'Document not found.' });
      return;
    }
    res.json({ ok: true });
  });

  router.post('/rag/search', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { query, collectionIds, topK } = req.body as {
        query?: string;
        collectionIds?: string[];
        topK?: number;
      };
      if (!query || !query.trim()) {
        res.status(400).json({ error: 'Search query is required.' });
        return;
      }

      const matches = await semanticSearch({
        userId: req.user!.id,
        query: query.trim(),
        collectionIds,
        topK: topK ?? 6,
      });

      res.json({ matches });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Semantic search failed.',
      });
    }
  });

  // ---------------- RESEARCH WORKFLOW & STREAMING ----------------

  router.get('/research', requireAuth, (req: AuthenticatedRequest, res) => {
    const db = getDb();
    const rows = db
      .prepare(`SELECT * FROM research_sessions WHERE user_id = ? ORDER BY created_at DESC`)
      .all(req.user!.id) as Array<Record<string, unknown>>;

    res.json({ sessions: rows.map(mapSessionRow) });
  });

  router.post('/research', requireAuth, researchLimiter, async (req: AuthenticatedRequest, res) => {
    try {
      const { question, mode, includeWeb, includeRag, collectionIds, maxRetries, provider } = req.body as {
        question?: string;
        mode?: 'standard' | 'deep' | 'document_focused';
        includeWeb?: boolean;
        includeRag?: boolean;
        collectionIds?: string[];
        maxRetries?: number;
        provider?: 'gemini' | 'ollama';
      };

      const session = await createAndPlanResearch({
        userId: req.user!.id,
        question: question ?? '',
        mode,
        includeWeb,
        includeRag,
        collectionIds,
        maxRetries,
        provider,
      });

      res.status(201).json({ session });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to initialize research session.',
      });
    }
  });

  router.get('/research/:id', requireAuth, (req: AuthenticatedRequest, res) => {
    const session = getResearchSession(String(req.params.id), req.user!.id);
    if (!session) {
      res.status(404).json({ error: 'Research session not found.' });
      return;
    }

    const db = getDb();
    const eventRows = db
      .prepare(`SELECT * FROM execution_events WHERE session_id = ? ORDER BY seq ASC`)
      .all(session.id) as Array<{
      id: string;
      session_id: string;
      seq: number;
      event_type: ExecutionEvent['eventType'];
      agent_id: ExecutionEvent['agentId'];
      message: string;
      payload_json: string | null;
      created_at: string;
    }>;

    const events: ExecutionEvent[] = eventRows.map((e) => ({
      id: e.id,
      sessionId: e.session_id,
      seq: e.seq,
      eventType: e.event_type,
      agentId: e.agent_id,
      message: e.message,
      payload: e.payload_json ? (JSON.parse(e.payload_json) as Record<string, unknown>) : null,
      createdAt: e.created_at,
    }));

    res.json({ session, events });
  });

  router.delete('/research/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
    const deleted = await deleteResearchSessionAndThread(String(req.params.id), req.user!.id);
    if (!deleted) {
      res.status(404).json({ error: 'Research session not found.' });
      return;
    }
    res.json({ ok: true });
  });

  router.post('/research/:id/approve', requireAuth, (req: AuthenticatedRequest, res) => {
    try {
      const { plan } = req.body as { plan?: ResearchPlan };
      const session = approveResearchPlan({
        sessionId: String(req.params.id),
        userId: req.user!.id,
        updatedPlan: plan,
      });
      res.json({ session });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to approve research plan.',
      });
    }
  });

  router.post('/research/:id/reject', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { reason, revise } = req.body as { reason?: string; revise?: boolean };
      const session = await rejectResearchPlan({
        sessionId: String(req.params.id),
        userId: req.user!.id,
        reason,
        revise: Boolean(revise),
      });
      res.json({ session });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to reject research plan.',
      });
    }
  });

  router.post('/research/:id/pause', requireAuth, (req: AuthenticatedRequest, res) => {
    try {
      const session = pauseResearchExecution({ sessionId: String(req.params.id), userId: req.user!.id });
      res.json({ session, requested: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unable to pause workflow.' });
    }
  });

  router.post('/research/:id/stop', requireAuth, (req: AuthenticatedRequest, res) => {
    try {
      const session = stopResearchExecution({ sessionId: String(req.params.id), userId: req.user!.id });
      res.json({ session, requested: session.status === 'running' });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unable to stop workflow.' });
    }
  });

  router.post('/research/:id/resume', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const session = await resumeResearchExecution({
        sessionId: String(req.params.id),
        userId: req.user!.id,
      });
      res.json({ session });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to resume research session.',
      });
    }
  });

  router.get('/research/:id/stream', requireAuth, (req: AuthenticatedRequest, res: Response) => {
    const session = getResearchSession(String(req.params.id), req.user!.id);
    if (!session) {
      res.status(404).json({ error: 'Research session not found.' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const lastEventIdHeader = req.headers['last-event-id'];
    const lastSeqParam = Number(
      (typeof lastEventIdHeader === 'string' ? lastEventIdHeader : req.query.afterSeq) ?? 0
    );
    const afterSeq = Number.isFinite(lastSeqParam) ? lastSeqParam : 0;

    const sendSse = (evt: ExecutionEvent) => {
      res.write(`id: ${evt.seq}\n`);
      res.write(`event: ${evt.eventType}\n`);
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    };

    const db = getDb();
    const pastRows = db
      .prepare(`SELECT * FROM execution_events WHERE session_id = ? AND seq > ? ORDER BY seq ASC`)
      .all(session.id, afterSeq) as Array<{
      id: string;
      session_id: string;
      seq: number;
      event_type: ExecutionEvent['eventType'];
      agent_id: ExecutionEvent['agentId'];
      message: string;
      payload_json: string | null;
      created_at: string;
    }>;

    for (const r of pastRows) {
      sendSse({
        id: r.id,
        sessionId: r.session_id,
        seq: r.seq,
        eventType: r.event_type,
        agentId: r.agent_id,
        message: r.message,
        payload: r.payload_json ? (JSON.parse(r.payload_json) as Record<string, unknown>) : null,
        createdAt: r.created_at,
      });
    }

    const listener = (evt: ExecutionEvent) => {
      sendSse(evt);
    };

    const channel = `session:${session.id}`;
    sessionBus.on(channel, listener);

    const heartbeat = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 15_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      sessionBus.off(channel, listener);
    });
  });

  // ---------------- FOLLOW-UP CONVERSATIONAL MEMORY ----------------

  router.get('/research/:id/messages', requireAuth, (req: AuthenticatedRequest, res) => {
    const session = getResearchSession(String(req.params.id), req.user!.id);
    if (!session) {
      res.status(404).json({ error: 'Research session not found.' });
      return;
    }

    const db = getDb();
    const rows = db
      .prepare(
        `SELECT id, session_id, role, content, citations_json, created_at FROM session_messages WHERE session_id = ? AND user_id = ? ORDER BY created_at ASC`
      )
      .all(session.id, req.user!.id) as Array<{
      id: string;
      session_id: string;
      role: 'user' | 'assistant';
      content: string;
      citations_json: string;
      created_at: string;
    }>;

    const messages: SessionMessage[] = rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      role: r.role,
      content: r.content,
      citations: JSON.parse(r.citations_json) as number[],
      createdAt: r.created_at,
    }));

    res.json({ messages });
  });

  router.post('/research/:id/messages', requireAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const session = getResearchSession(String(req.params.id), req.user!.id);
      if (!session) {
        res.status(404).json({ error: 'Research session not found.' });
        return;
      }
      const { content } = req.body as { content?: string };
      const cleanQuestion = (content ?? '').trim();
      if (!cleanQuestion) {
        res.status(400).json({ error: 'Message content is required.' });
        return;
      }
      if (!hasGeminiKey()) {
        res.status(503).json({
          error: 'GEMINI_API_KEY is required to answer follow-up questions.',
        });
        return;
      }

      const db = getDb();
      const now = new Date().toISOString();
      const userMsgId = `msg-${crypto.randomUUID()}`;
      db.prepare(`
        INSERT INTO session_messages (id, session_id, user_id, role, content, citations_json, created_at)
        VALUES (?, ?, ?, 'user', ?, '[]', ?)
      `).run(userMsgId, session.id, req.user!.id, cleanQuestion, now);

      const sources = session.checkpoint?.sources ?? [];
      const claims = session.checkpoint?.claims ?? [];
      const contradictions = session.checkpoint?.contradictions ?? [];

      const evidenceContext = sources
        .map((s) => `[${s.citationNumber}] ${s.title} (${s.url}): ${s.snippet}`)
        .join('\n');
      const claimsContext = claims
        .map((c) => `- (${c.verificationStatus}, conf=${c.confidenceScore}) ${c.statement}`)
        .join('\n');

      const ai = getGeminiClient();
      const response = await withExponentialBackoff(() =>
        ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: `Research Question: ${session.question}

Collected Sources:
${evidenceContext}

Verified Claims:
${claimsContext}

Preserved Contradictions:
${JSON.stringify(contradictions)}

Follow-up Question: ${cleanQuestion}

Answer concisely using ONLY the evidence and claims collected above. Include bracket citations like [1], [2]. If the collected evidence does not answer the follow-up, state that explicitly.`,
          config: {
            systemInstruction:
              'You are Orchestra AI Follow-Up Analyst. Never fabricate evidence outside the session sources.',
          },
        })
      );

      const replyText = (response.text ?? '').trim() || 'No evidence-grounded response generated.';
      const citedNums = Array.from(
        new Set(Array.from(replyText.matchAll(/\[(\d+)\]/g)).map((m) => Number(m[1])))
      ).filter((n) => sources.some((s) => s.citationNumber === n));

      const assistantMsgId = `msg-${crypto.randomUUID()}`;
      const replyTime = new Date().toISOString();
      db.prepare(`
        INSERT INTO session_messages (id, session_id, user_id, role, content, citations_json, created_at)
        VALUES (?, ?, ?, 'assistant', ?, ?, ?)
      `).run(
        assistantMsgId,
        session.id,
        req.user!.id,
        replyText,
        JSON.stringify(citedNums),
        replyTime
      );

      res.status(201).json({
        userMessage: {
          id: userMsgId,
          sessionId: session.id,
          role: 'user',
          content: cleanQuestion,
          citations: [],
          createdAt: now,
        },
        assistantMessage: {
          id: assistantMsgId,
          sessionId: session.id,
          role: 'assistant',
          content: replyText,
          citations: citedNums,
          createdAt: replyTime,
        },
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Follow-up query failed.',
      });
    }
  });

  return router;
}
