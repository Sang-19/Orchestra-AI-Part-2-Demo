import { generateSearchGroundedFindings, hasGeminiKey } from '../ai/geminiClient';
import { sanitizeUntrustedText } from './stateMachine';

export interface WebSearchHit {
  title: string;
  url: string;
  domain: string;
  snippet: string;
  publishedAt: string | null;
  engine: 'tavily' | 'gemini_google_search';
}

export function hasTavilyKey(): boolean {
  const key = process.env.TAVILY_API_KEY?.trim();
  return Boolean(key && key.length > 8);
}

function extractDomain(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, '');
  } catch {
    return 'web-source';
  }
}

export async function searchWeb(params: {
  query: string;
  objective: string;
  maxResults?: number;
}): Promise<WebSearchHit[]> {
  const maxResults = params.maxResults ?? 4;
  const hits: WebSearchHit[] = [];

  if (hasTavilyKey()) {
    try {
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          api_key: process.env.TAVILY_API_KEY,
          query: params.query,
          search_depth: 'advanced',
          include_answer: false,
          max_results: maxResults,
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (response.ok) {
        const data = (await response.json()) as {
          results?: Array<{
            title?: string;
            url?: string;
            content?: string;
            published_date?: string;
          }>;
        };

        for (const r of data.results ?? []) {
          if (!r.url || !r.content) continue;
          hits.push({
            title: sanitizeUntrustedText(r.title || r.url, 200),
            url: r.url,
            domain: extractDomain(r.url),
            snippet: sanitizeUntrustedText(r.content, 1200),
            publishedAt: r.published_date || null,
            engine: 'tavily',
          });
        }
      }
    } catch {
      // Fall through to Gemini Google Search Grounding if Tavily request fails
    }
  }

  if (hits.length === 0 && hasGeminiKey()) {
    const grounded = await generateSearchGroundedFindings({
      query: params.query,
      objective: params.objective,
    });

    if (grounded.sources.length > 0) {
      for (const s of grounded.sources.slice(0, maxResults)) {
        hits.push({
          title: sanitizeUntrustedText(s.title, 200),
          url: s.url,
          domain: extractDomain(s.url),
          snippet: sanitizeUntrustedText(grounded.summary, 1400),
          publishedAt: null,
          engine: 'gemini_google_search',
        });
      }
    } else if (grounded.summary) {
      hits.push({
        title: `Search Synthesis: ${params.query}`,
        url: 'https://www.google.com/search?q=' + encodeURIComponent(params.query),
        domain: 'google.com',
        snippet: sanitizeUntrustedText(grounded.summary, 1400),
        publishedAt: null,
        engine: 'gemini_google_search',
      });
    }
  }

  return hits;
}
