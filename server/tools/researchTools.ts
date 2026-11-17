import crypto from 'node:crypto';
import { tool } from '@langchain/core/tools';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { z } from 'zod';
import { semanticSearch } from '../rag/documentProcessor';
import { searchWeb } from '../orchestrator/webSearch';
import { queryEnabledCustomSearchTools } from './customTools';
import { renderReportMarkdown, sanitizeUntrustedText } from '../orchestrator/stateMachine';
import type {
  ContradictionRecord,
  GroundednessResult,
  ResearchReport,
  SourceRecord,
} from '../../src/types/research';

/**
 * Deterministic Citation Management tool:
 * Deduplicates sources by canonical URL and assigns stable sequential citation numbers.
 */
export function deduplicateAndNumberSources(
  existing: SourceRecord[],
  incoming: SourceRecord[]
): SourceRecord[] {
  const seenUrls = new Set<string>();
  const merged: SourceRecord[] = [];

  for (const src of [...existing, ...incoming]) {
    const key = src.url.trim().toLowerCase();
    if (!key || seenUrls.has(key)) continue;
    seenUrls.add(key);
    merged.push({
      ...src,
      citationNumber: merged.length + 1,
    });
  }

  return merged;
}

/**
 * Deterministic Source Processing tool:
 * Combines Knowledge Base RAG retrieval, Tavily / Gemini Google Search Grounding,
 * and enabled user-generated HTTP tools for a single research subtopic.
 */
export async function executeSubtopicToolSuite(params: {
  userId: string;
  objective: string;
  subtopicId: string;
  subtopicTitle: string;
  queries: string[];
  includeWeb: boolean;
  includeRag: boolean;
  collectionIds: string[];
  startingCitationNumber: number;
}): Promise<{ sources: SourceRecord[]; gaps: string[] }> {
  const uniqueQueries = Array.from(
    new Set(params.queries.map((q) => q.trim()).filter(Boolean))
  ).slice(0, 3);

  const collected: SourceRecord[] = [];
  const gaps: string[] = [];
  let citationNum = params.startingCitationNumber;

  if (params.includeRag) {
    for (const q of uniqueQueries) {
      try {
        const ragHits = await semanticSearch({
          userId: params.userId,
          query: q,
          collectionIds: params.collectionIds.length > 0 ? params.collectionIds : undefined,
          topK: 3,
        });
        for (const hit of ragHits) {
          if (hit.score < 0.12) continue;
          collected.push({
            id: `src-${crypto.randomUUID()}`,
            citationNumber: citationNum++,
            title: `${hit.filename} (Chunk #${hit.chunkIndex + 1})`,
            url: `kb://${hit.documentId}#chunk-${hit.chunkIndex}`,
            domain: 'Internal Knowledge Base',
            snippet: sanitizeUntrustedText(hit.content, 1100),
            publishedAt: null,
            sourceType: 'document',
            subtopicId: params.subtopicId,
            credibilityScore: 0.85,
            credibilityTier: 'primary',
            credibilityReasoning: 'Pending source credibility assessment.',
            isOutdated: false,
            isDuplicate: false,
          });
        }
      } catch (err) {
        gaps.push(
          `Knowledge Base search for "${q}" failed: ${err instanceof Error ? err.message : 'unknown'}`
        );
      }
    }
  }

  if (params.includeWeb) {
    for (const q of uniqueQueries.slice(0, 2)) {
      try {
        const webHits = await searchWeb({
          query: q,
          objective: params.objective,
          maxResults: 3,
        });
        for (const w of webHits) {
          collected.push({
            id: `src-${crypto.randomUUID()}`,
            citationNumber: citationNum++,
            title: w.title,
            url: w.url,
            domain: w.domain,
            snippet: w.snippet,
            publishedAt: w.publishedAt,
            sourceType: 'web',
            subtopicId: params.subtopicId,
            credibilityScore: 0.7,
            credibilityTier: 'secondary',
            credibilityReasoning: 'Pending source credibility assessment.',
            isOutdated: false,
            isDuplicate: false,
          });
        }
      } catch (err) {
        gaps.push(
          `Web search for "${q}" encountered an error: ${err instanceof Error ? err.message : 'unknown'}`
        );
      }
    }
  }

  if (uniqueQueries.length > 0) {
    try {
      const customHits = await queryEnabledCustomSearchTools({
        userId: params.userId,
        query: uniqueQueries[0],
      });
      for (const hit of customHits) {
        collected.push({
          id: `src-${crypto.randomUUID()}`,
          citationNumber: citationNum++,
          title: hit.title,
          url: hit.url,
          domain: hit.domain,
          snippet: hit.snippet,
          publishedAt: null,
          sourceType: 'web',
          subtopicId: params.subtopicId,
          credibilityScore: 0.72,
          credibilityTier: 'secondary',
          credibilityReasoning: `Retrieved from user-configured tool "${hit.toolName}".`,
          isOutdated: false,
          isDuplicate: false,
        });
      }
    } catch (err) {
      gaps.push(
        `Custom HTTP tools failed for "${uniqueQueries[0]}": ${err instanceof Error ? err.message : 'unknown'}`
      );
    }
  }

  if (collected.length === 0) {
    gaps.push(`No strong sources retrieved for subtopic "${params.subtopicTitle}".`);
  }

  return { sources: collected, gaps };
}

/**
 * Deterministic Report Formatting tool wrapper.
 */
export function formatResearchReportTool(params: {
  report: Omit<ResearchReport, 'markdownContent'>;
  sources: SourceRecord[];
  contradictions: ContradictionRecord[];
  groundedness: GroundednessResult | null;
}): string {
  return renderReportMarkdown(params);
}

/**
 * Reusable LangChain Tool definitions compatible with LangGraph `ToolNode`.
 * Strictly separates tool execution from agent reasoning.
 */
export function createOrchestraLangChainTools(context: {
  userId: string;
  collectionIds?: string[];
  objective?: string;
}) {
  const webSearchTool = tool(
    async ({ query, maxResults }) => {
      const hits = await searchWeb({
        query,
        objective: context.objective ?? query,
        maxResults: maxResults ?? 3,
      });
      return JSON.stringify(hits);
    },
    {
      name: 'web_search',
      description:
        'Search the live web using Tavily API or Gemini Google Search Grounding to retrieve cited evidence snippets.',
      schema: z.object({
        query: z.string().describe('Focused factual search query'),
        maxResults: z.number().int().min(1).max(6).optional(),
      }),
    }
  );

  const knowledgeBaseSearchTool = tool(
    async ({ query, topK }) => {
      const matches = await semanticSearch({
        userId: context.userId,
        query,
        collectionIds:
          context.collectionIds && context.collectionIds.length > 0
            ? context.collectionIds
            : undefined,
        topK: topK ?? 4,
      });
      return JSON.stringify(
        matches.map((m) => ({
          documentId: m.documentId,
          filename: m.filename,
          chunkIndex: m.chunkIndex,
          score: m.score,
          content: sanitizeUntrustedText(m.content, 800),
        }))
      );
    },
    {
      name: 'knowledge_base_retrieval',
      description:
        'Retrieve semantically relevant chunks from the user-isolated RAG document knowledge base.',
      schema: z.object({
        query: z.string().describe('Semantic search query for uploaded documents'),
        topK: z.number().int().min(1).max(8).optional(),
      }),
    }
  );

  const customApiSearchTool = tool(
    async ({ query }) => {
      const hits = await queryEnabledCustomSearchTools({
        userId: context.userId,
        query,
      });
      return JSON.stringify(hits);
    },
    {
      name: 'user_custom_api_search',
      description:
        'Query all enabled user-generated HTTP search and webhook tools registered in the workspace.',
      schema: z.object({
        query: z.string().describe('Query string interpolated into {{query}} placeholders'),
      }),
    }
  );

  const citationDeduplicatorTool = tool(
    async ({ urls }) => {
      const unique = Array.from(
        new Set(urls.map((u) => u.trim().toLowerCase()).filter(Boolean))
      );
      return JSON.stringify({ uniqueCount: unique.length, uniqueUrls: unique });
    },
    {
      name: 'citation_deduplicator',
      description: 'Deterministically deduplicate and normalize citation URLs.',
      schema: z.object({
        urls: z.array(z.string()).describe('List of source URLs to deduplicate'),
      }),
    }
  );

  const tools = [
    webSearchTool,
    knowledgeBaseSearchTool,
    customApiSearchTool,
    citationDeduplicatorTool,
  ];

  return {
    tools,
    toolNode: new ToolNode(tools),
  };
}
