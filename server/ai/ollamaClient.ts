export interface OllamaConfig {
  baseUrl: string;
  model: string;
  embedModel: string;
}

export function isOllamaProviderEnabled(): boolean {
  return (process.env.LLM_PROVIDER || '').trim().toLowerCase() === 'ollama';
}

/** Enables local Nomic embeddings while Gemini remains the text-generation provider. */
export function isOllamaEmbeddingEnabled(): boolean {
  return isOllamaProviderEnabled() || (process.env.EMBEDDING_PROVIDER || '').trim().toLowerCase() === 'ollama';
}

export function getOllamaConfig(): OllamaConfig {
  return {
    baseUrl: (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/+$/, ''),
    model: (process.env.OLLAMA_MODEL || 'llama3.1:8b').trim(),
    embedModel: (process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text').trim(),
  };
}

export function extractJsonFromModelText(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    return fenced[1].trim();
  }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

export async function ollamaGenerateStructuredJson<T>(params: {
  systemInstruction: string;
  prompt: string;
  config?: Partial<OllamaConfig>;
}): Promise<T> {
  const cfg = { ...getOllamaConfig(), ...params.config };
  const res = await fetch(`${cfg.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      stream: false,
      format: 'json',
      messages: [
        {
          role: 'system',
          content: `${params.systemInstruction}\nReturn ONLY valid JSON matching the requested fields with no markdown prose.`,
        },
        {
          role: 'user',
          content: params.prompt,
        },
      ],
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Ollama chat request failed (${res.status}): ${errBody || res.statusText}`);
  }

  const data = (await res.json()) as { message?: { content?: string } };
  const raw = (data.message?.content ?? '').trim();
  if (!raw) {
    throw new Error('Ollama returned an empty response.');
  }

  const cleaned = extractJsonFromModelText(raw);
  return JSON.parse(cleaned) as T;
}

export async function ollamaEmbedTexts(
  texts: string[],
  config?: Partial<OllamaConfig>
): Promise<{ embeddings: number[][]; model: string }> {
  const cfg = { ...getOllamaConfig(), ...config };
  if (texts.length === 0) {
    return { embeddings: [], model: cfg.embedModel };
  }

  const res = await fetch(`${cfg.baseUrl}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.embedModel,
      input: texts,
    }),
    signal: AbortSignal.timeout(45_000),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Ollama embed request failed (${res.status}): ${errBody || res.statusText}`);
  }

  const data = (await res.json()) as { embeddings?: number[][] };
  const embeddings = data.embeddings ?? [];
  if (embeddings.length !== texts.length) {
    throw new Error('Ollama embedding count mismatch.');
  }
  return { embeddings, model: `ollama:${cfg.embedModel}` };
}

export async function probeOllamaEndpoint(baseUrl: string): Promise<{
  ok: boolean;
  statusCode: number | null;
  models: string[];
  message: string;
}> {
  const normalized = baseUrl.replace(/\/+$/, '');
  try {
    const res = await fetch(`${normalized}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return {
        ok: false,
        statusCode: res.status,
        models: [],
        message: `Ollama responded with HTTP ${res.status}.`,
      };
    }
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    const models = (data.models ?? []).map((m) => m.name || '').filter(Boolean);
    return {
      ok: true,
      statusCode: res.status,
      models,
      message:
        models.length > 0
          ? `Connected to Ollama (${models.length} local ${models.length === 1 ? 'model' : 'models'} available).`
          : 'Connected to Ollama server (no models pulled yet; run "ollama pull llama3.1:8b").',
    };
  } catch (err) {
    return {
      ok: false,
      statusCode: null,
      models: [],
      message: `Cannot reach Ollama at ${normalized}. (${err instanceof Error ? err.message : 'connection refused'})`,
    };
  }
}
