import crypto from 'node:crypto';
import path from 'node:path';
import mammoth from 'mammoth';
import { extractText } from 'unpdf';
import { getDb } from '../db/database';
import { embedTexts, hasGeminiKey } from '../ai/geminiClient';
import {
  chunkText,
  cleanDocumentText,
  computeContentHash,
  computeDeterministicEmbedding,
  cosineSimilarity,
} from './chunker';
import type { DocumentRecord, RetrievalMatch } from '../../src/types/research';

const ALLOWED_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.json', '.pdf', '.docx']);
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15 MB

export async function extractDocumentText(params: {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}): Promise<string> {
  const ext = path.extname(params.filename).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(
      `Unsupported file format (${ext || 'unknown'}). Allowed: .pdf, .docx, .txt, .md, .csv, .json`
    );
  }

  if (ext === '.pdf' || params.mimeType === 'application/pdf') {
    const data = new Uint8Array(params.buffer);
    const result = await extractText(data, { mergePages: true });
    return cleanDocumentText(Array.isArray(result.text) ? result.text.join('\n') : result.text);
  }

  if (
    ext === '.docx' ||
    params.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    const result = await mammoth.extractRawText({ buffer: params.buffer });
    return cleanDocumentText(result.value);
  }

  return cleanDocumentText(params.buffer.toString('utf8'));
}

export async function ingestDocument(params: {
  userId: string;
  collectionId: string | null;
  filename: string;
  mimeType: string;
  buffer: Buffer;
  chunkSize?: number;
  overlap?: number;
}): Promise<DocumentRecord> {
  const db = getDb();
  const now = new Date().toISOString();
  const docId = `doc-${crypto.randomUUID()}`;

  if (params.buffer.length === 0) {
    throw new Error('Uploaded file is empty.');
  }
  if (params.buffer.length > MAX_UPLOAD_BYTES) {
    throw new Error('File exceeds the 15 MB upload limit.');
  }

  if (params.collectionId) {
    const ownsCol = db
      .prepare(`SELECT id FROM collections WHERE id = ? AND user_id = ?`)
      .get(params.collectionId, params.userId);
    if (!ownsCol) {
      throw new Error('Target collection not found or access denied.');
    }
  }

  const text = await extractDocumentText({
    buffer: params.buffer,
    filename: params.filename,
    mimeType: params.mimeType,
  });

  if (text.length < 10) {
    throw new Error('Document contains insufficient extractable text.');
  }

  const contentHash = computeContentHash(text);

  // Duplicate detection scoped to the user's knowledge base
  const duplicate = db
    .prepare(`SELECT id, filename FROM documents WHERE user_id = ? AND content_hash = ? AND status = 'indexed'`)
    .get(params.userId, contentHash) as { id: string; filename: string } | undefined;

  if (duplicate) {
    db.prepare(`
      INSERT INTO documents (id, user_id, collection_id, filename, mime_type, file_size, content_hash, status, chunk_count, char_count, error_message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'duplicate', 0, ?, ?, ?)
    `).run(
      docId,
      params.userId,
      params.collectionId,
      params.filename,
      params.mimeType,
      params.buffer.length,
      contentHash,
      text.length,
      `Duplicate of already indexed document "${duplicate.filename}".`,
      now
    );
    return getDocumentById(docId, params.userId)!;
  }

  db.prepare(`
    INSERT INTO documents (id, user_id, collection_id, filename, mime_type, file_size, content_hash, status, chunk_count, char_count, error_message, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'processing', 0, ?, NULL, ?)
  `).run(
    docId,
    params.userId,
    params.collectionId,
    params.filename,
    params.mimeType,
    params.buffer.length,
    contentHash,
    text.length,
    now
  );

  try {
    const chunks = chunkText(text, {
      chunkSize: params.chunkSize ?? 900,
      overlap: params.overlap ?? 160,
    });

    if (chunks.length === 0) {
      throw new Error('Chunking yielded zero valid text segments.');
    }

    let vectors: number[][] = [];
    let embeddingModel = 'deterministic-v1';

    if (hasGeminiKey()) {
      try {
        const batchSize = 20;
        for (let i = 0; i < chunks.length; i += batchSize) {
          const batch = chunks.slice(i, i + batchSize).map((c) => c.content);
          const embedded = await embedTexts(batch);
          vectors.push(...embedded.embeddings);
          embeddingModel = embedded.model;
        }
      } catch {
        vectors = chunks.map((c) => computeDeterministicEmbedding(c.content));
        embeddingModel = 'deterministic-v1';
      }
    } else {
      vectors = chunks.map((c) => computeDeterministicEmbedding(c.content));
    }

    const insertChunk = db.prepare(`
      INSERT INTO document_chunks (id, document_id, user_id, collection_id, chunk_index, content, token_estimate, metadata_json, embedding_json, embedding_model, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = db.transaction(() => {
      chunks.forEach((ch, idx) => {
        insertChunk.run(
          `chk-${crypto.randomUUID()}`,
          docId,
          params.userId,
          params.collectionId,
          ch.index,
          ch.content,
          ch.tokenEstimate,
          JSON.stringify({
            filename: params.filename,
            charStart: ch.charStart,
            charEnd: ch.charEnd,
          }),
          JSON.stringify(vectors[idx]),
          embeddingModel,
          now
        );
      });

      db.prepare(`UPDATE documents SET status = 'indexed', chunk_count = ? WHERE id = ?`).run(
        chunks.length,
        docId
      );
    });

    tx();
    return getDocumentById(docId, params.userId)!;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown document processing error';
    db.prepare(`UPDATE documents SET status = 'failed', error_message = ? WHERE id = ?`).run(
      message,
      docId
    );
    throw err;
  }
}

export function getDocumentById(documentId: string, userId: string): DocumentRecord | null {
  const db = getDb();
  const row = db
    .prepare(
      `
      SELECT d.*, c.name as collection_name
      FROM documents d
      LEFT JOIN collections c ON c.id = d.collection_id
      WHERE d.id = ? AND d.user_id = ?
    `
    )
    .get(documentId, userId) as
    | {
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
      }
    | undefined;

  if (!row) return null;

  return {
    id: row.id,
    userId: row.user_id,
    collectionId: row.collection_id,
    collectionName: row.collection_name,
    filename: row.filename,
    mimeType: row.mime_type,
    fileSize: row.file_size,
    status: row.status,
    chunkCount: row.chunk_count,
    charCount: row.char_count,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  };
}

export async function semanticSearch(params: {
  userId: string;
  query: string;
  collectionIds?: string[];
  topK?: number;
}): Promise<RetrievalMatch[]> {
  const db = getDb();
  const topK = Math.min(20, Math.max(1, params.topK ?? 6));
  const queryText = params.query.trim();
  if (!queryText) return [];

  let sql = `
    SELECT dc.id as chunk_id, dc.document_id, dc.collection_id, dc.chunk_index, dc.content,
           dc.metadata_json, dc.embedding_json, dc.embedding_model, d.filename
    FROM document_chunks dc
    INNER JOIN documents d ON d.id = dc.document_id
    WHERE dc.user_id = ? AND d.status = 'indexed'
  `;
  const args: unknown[] = [params.userId];

  if (params.collectionIds && params.collectionIds.length > 0) {
    const placeholders = params.collectionIds.map(() => '?').join(', ');
    sql += ` AND dc.collection_id IN (${placeholders})`;
    args.push(...params.collectionIds);
  }

  const rows = db.prepare(sql).all(...args) as Array<{
    chunk_id: string;
    document_id: string;
    collection_id: string | null;
    chunk_index: number;
    content: string;
    metadata_json: string;
    embedding_json: string;
    embedding_model: string;
    filename: string;
  }>;

  if (rows.length === 0) return [];

  let geminiQueryVec: number[] | null = null;
  const hasGeminiChunks = rows.some((r) => r.embedding_model === 'gemini-embedding-2');
  if (hasGeminiChunks && hasGeminiKey()) {
    try {
      const res = await embedTexts([queryText]);
      geminiQueryVec = res.embeddings[0] ?? null;
    } catch {
      geminiQueryVec = null;
    }
  }
  const fallbackQueryVec = computeDeterministicEmbedding(queryText);

  const queryTerms = queryText
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 3);

  const scored: RetrievalMatch[] = rows.map((row) => {
    const chunkVec = JSON.parse(row.embedding_json) as number[];
    const qVec =
      row.embedding_model === 'gemini-embedding-2' && geminiQueryVec
        ? geminiQueryVec
        : fallbackQueryVec;

    let sim = 0;
    if (chunkVec.length === qVec.length) {
      sim = cosineSimilarity(qVec, chunkVec);
    } else {
      // Cross-model lexical + deterministic projection fallback
      sim = cosineSimilarity(
        computeDeterministicEmbedding(queryText),
        computeDeterministicEmbedding(row.content)
      );
    }

    // Lexical exact-term boost for precise technical entity retrieval
    const lowerContent = row.content.toLowerCase();
    let lexicalHits = 0;
    for (const term of queryTerms) {
      if (lowerContent.includes(term)) lexicalHits++;
    }
    const lexicalBoost = queryTerms.length > 0 ? (lexicalHits / queryTerms.length) * 0.25 : 0;
    const finalScore = Math.max(0, Math.min(1, Number((sim * 0.8 + lexicalBoost).toFixed(4))));

    return {
      chunkId: row.chunk_id,
      documentId: row.document_id,
      filename: row.filename,
      collectionId: row.collection_id,
      chunkIndex: row.chunk_index,
      content: row.content,
      score: finalScore,
      metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
