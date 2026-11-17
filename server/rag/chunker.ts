import crypto from 'node:crypto';

export interface TextChunk {
  index: number;
  content: string;
  tokenEstimate: number;
  charStart: number;
  charEnd: number;
}

export function cleanDocumentText(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function computeContentHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function chunkText(
  rawText: string,
  options: { chunkSize?: number; overlap?: number } = {}
): TextChunk[] {
  const chunkSize = Math.max(200, options.chunkSize ?? 900);
  const overlap = Math.min(Math.floor(chunkSize * 0.4), Math.max(0, options.overlap ?? 160));

  const cleaned = cleanDocumentText(rawText);
  if (!cleaned) return [];

  const chunks: TextChunk[] = [];
  let cursor = 0;
  let idx = 0;

  while (cursor < cleaned.length) {
    let end = Math.min(cleaned.length, cursor + chunkSize);

    if (end < cleaned.length) {
      const slice = cleaned.slice(cursor, end);
      const lastParagraph = slice.lastIndexOf('\n\n');
      const lastSentence = Math.max(
        slice.lastIndexOf('. '),
        slice.lastIndexOf('? '),
        slice.lastIndexOf('! ')
      );
      const lastSpace = slice.lastIndexOf(' ');

      if (lastParagraph > chunkSize * 0.45) {
        end = cursor + lastParagraph + 2;
      } else if (lastSentence > chunkSize * 0.45) {
        end = cursor + lastSentence + 2;
      } else if (lastSpace > chunkSize * 0.5) {
        end = cursor + lastSpace + 1;
      }
    }

    const piece = cleaned.slice(cursor, end).trim();
    if (piece.length > 0) {
      chunks.push({
        index: idx++,
        content: piece,
        tokenEstimate: Math.max(1, Math.ceil(piece.length / 4)),
        charStart: cursor,
        charEnd: end,
      });
    }

    if (end >= cleaned.length) break;
    const nextCursor = Math.max(cursor + 1, end - overlap);
    cursor = nextCursor;
  }

  return chunks;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Deterministic 128-dim character-trigram + word-token hashed embedding fallback
 * used only when external embedding API calls are unavailable (e.g., unit tests or quota errors).
 */
export function computeDeterministicEmbedding(text: string, dims = 128): number[] {
  const vec = new Array<number>(dims).fill(0);
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const tokens = normalized.split(/\s+/).filter((t) => t.length >= 2);

  for (const token of tokens) {
    let h = 2166136261;
    for (let i = 0; i < token.length; i++) {
      h ^= token.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const bucket = Math.abs(h) % dims;
    const sign = (h & 1) === 0 ? 1 : -1;
    vec[bucket] += sign * 1.5;

    for (let i = 0; i <= token.length - 3; i++) {
      const tri = token.slice(i, i + 3);
      let th = 2166136261;
      for (let j = 0; j < tri.length; j++) {
        th ^= tri.charCodeAt(j);
        th = Math.imul(th, 16777619);
      }
      vec[Math.abs(th) % dims] += ((th & 1) === 0 ? 1 : -1) * 0.5;
    }
  }

  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}
