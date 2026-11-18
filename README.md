# Orchestra AI — Autonomous Multi-Agent Research Platform

Orchestra AI is a full-stack autonomous research platform that coordinates specialized AI agents to decompose questions, gather live web and private RAG evidence, verify factual claims, grade source credibility, preserve contradictions, validate report groundedness, and trigger adaptive retries when evidence is insufficient.

## Architecture

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Vite, buffered SSE streaming (`src/utils/sseParser.ts`)
- **Backend**: Node.js + Express (`server.ts`, `server/routes/api.ts`), JWT authentication (`bcryptjs` + HTTP-only cookies), SQLite WAL persistence (`better-sqlite3`)
- **AI & Orchestration**: Per-agent Gemini model routing through one `GEMINI_API_KEY`, quota-aware fallback across configured Gemini models, optional Ollama generation, independently selectable local Nomic embeddings, and optional Tavily Search API (`TAVILY_API_KEY`)
- **Multi-Agent Pipeline**:
  1. Input Validation & Prompt-Injection Sanitization
  2. Planner Agent (generates structured subtopics & search queries)
  3. Human Approval Checkpoint (durable pause for plan inspection, edits, approval, or rejection)
  4. Research Coordinator & Parallel Researcher Agents (Tavily / Gemini Google Search Grounding + isolated RAG retrieval)
  5. Evidence Extraction Agent (atomic claims linked to source passages)
  6. Fact Checker Agent (verifies claims against evidence with calibrated confidence scores)
  7. Source Credibility Agent (primary/secondary/tertiary grading, recency & duplicate flags)
  8. Contradiction Checker Agent (preserves unresolved conflicts & contextual differences)
  9. Summarizer Agent (topic-wise synthesis & knowledge gaps)
  10. Writer Agent (structured cited report + Markdown export)
  11. Groundedness Checker Agent (audits claims & citations; never passes failed validation)
  12. Research Quality Evaluator (triggers adaptive research retries up to configured limit)

## Local Development

### Recommended: separate frontend and backend containers (Windows)

Run `start.bat`. Docker Compose starts two independent services and opens two CMD log windows automatically:

- **Frontend** — Vite + React at `http://localhost:5173` (HMR enabled; frontend logs in its own CMD window).
- **Backend** — Express + LangGraph + SQLite API at `http://localhost:3000` (backend logs in its own CMD window).
- Browser requests to `/api` and SSE endpoints are proxied by Vite to the backend container. The browser uses one origin, so API calls and authentication cookies continue to work without frontend CORS configuration.

Run `stop.bat` to stop both services. The named `orchestra_data` SQLite volume is preserved.

### Alternative: embedded single-process development

```bash
npm install
cp .env.example .env
# Set GEMINI_API_KEY (and optionally TAVILY_API_KEY)
npm run dev
```

This legacy convenience mode serves Vite through Express at `http://localhost:3000`.

## Per-Agent Model Routing

Choose a primary Gemini model for each agent in Workspace Settings. All agents share one `GEMINI_API_KEY`; quota/rate-limit and unavailable-model errors trigger role-specific fallbacks. Ollama can run all text generation, or be used only for embeddings with `EMBEDDING_PROVIDER=ollama` while Gemini handles text. Docker Compose defaults to local Ollama embeddings; set `EMBEDDING_PROVIDER=gemini` to use Gemini embeddings instead.

## Verification & Testing

```bash
npm run lint
npm test
npm run build
```

## Docker Services

Compose runs independent `backend` and `frontend` services. The backend image is defined in `backend/Dockerfile`; the Vite frontend image is defined in `frontend/Dockerfile`. The backend persists SQLite data in the named `orchestra_data` volume. To start both services manually, run `docker compose up --build -d backend frontend`; to inspect logs, run `docker compose logs -f backend` or `docker compose logs -f frontend`.
