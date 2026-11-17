# Orchestra AI — Tools, Agent Integrations & Local Ollama Guide

This guide explains:
1. Every built-in tool and agent integration in Orchestra AI (what it does, which agent uses it, and what setup it needs).
2. How to create **User-Generated Tools & API Integrations** directly inside the website (`Tools & APIs` page).
3. How to run the Orchestra AI backend with **local models using Ollama** (offline / self-hosted setup).

---

## 1. Built-In Tools & Agent Integrations Breakdown

Orchestra AI runs a 13-stage multi-agent workflow. Each core capability maps to a backend integration:

| Integration | Used By Agents | Purpose | Setup Requirement |
| :--- | :--- | :--- | :--- |
| **Google Gemini Reasoning Engine** (`gemini-4-hydrogen`) | Planner, Evidence Extraction, Fact Checker, Source Credibility, Contradiction Checker, Summarizer, Writer, Groundedness Checker, Quality Evaluator | Structured JSON schema generation, claim verification, report drafting, and follow-up Q&A. | **Required** unless `LLM_PROVIDER=ollama`. Set `GEMINI_API_KEY` in `.env` or Settings > Secrets. |
| **Ollama Local Model Backend** (`server/ai/ollamaClient.ts`) | All 10 reasoning agents + RAG Embeddings | Runs structured JSON inference (`/api/chat` with `format: "json"`) and embeddings (`/api/embed`) against local models. | **Optional** (local or Docker self-hosting). Set `LLM_PROVIDER=ollama` in `.env`. |
| **Vector Embeddings Engine** | RAG Ingestion (`documentProcessor.ts`) & Researcher Agent | Embeds uploaded PDF/DOCX/MD/TXT chunks and performs Top-K cosine similarity retrieval. | Automatic: uses `gemini-embedding-2` (or `ollama:nomic-embed-text` when `LLM_PROVIDER=ollama`), with deterministic vector fallback offline. |
| **Tavily Web Search API** (`server/orchestrator/webSearch.ts`) | Researcher Agent | Deep web search returning factual snippets, URLs, and publication dates. | **Optional.** Add `TAVILY_API_KEY` to `.env`. If omitted, Orchestra AI automatically uses Gemini Google Search Grounding. |
| **Gemini Google Search Grounding** | Researcher Agent | Built-in live web discovery returning grounded citations (`groundingChunks`). | Automatic whenever `GEMINI_API_KEY` is configured. |
| **SQLite Checkpoint & Vector Store** (`server/db/database.ts`) | Workflow Engine, Auth, Memory, RAG | Persists users, sessions, durable workflow checkpoints (survives restarts), SSE event logs, document chunks, and user-generated tools. | **Zero setup** — auto-initializes `./data/orchestra.db` in WAL mode. |
| **Document Ingestion Pipeline** (`server/rag/documentProcessor.ts`) | Knowledge & Memory UI | Parses `.pdf` (`unpdf`), `.docx` (`mammoth`), `.md`, `.txt`, `.csv`, `.json` with SHA-256 deduplication and overlapping chunking. | **Zero setup** — built-in. |

---

## 2. User-Generated Tools & APIs (In-Website Builder)

You can define, edit, toggle, test, and delete your own custom tools directly in the **Tools & APIs** page of the website. Custom tools are stored per-user in SQLite (`custom_tools` table) so other users cannot access your configurations.

### Supported User-Generated Tool Types

1. **Custom HTTP Search / Data API (`http_search`)**
   - Automatically queried by the **Researcher Agent** during research sessions whenever enabled.
   - Supports the `{{query}}` placeholder inside the Endpoint URL (for `GET`) or sends `{ "query": "..." }` as JSON body (for `POST`).
   - Returned text is sanitized against prompt injection and attached as a traceable `SourceRecord` with citation numbering.
   - **Example (Public ArXiv Search — no key needed):**
     - Name: `ArXiv Preprint Search`
     - Type: `Custom HTTP Search API`
     - Method: `GET`
     - Endpoint URL: `https://export.arxiv.org/api/query?search_query=all:{{query}}&start=0&max_results=3`
     - Capabilities: `Academic Preprints, Physics & CS Papers, XML Feed`
   - **Example (Wikipedia Summary API — no key needed):**
     - Name: `Wikipedia Search API`
     - Type: `Custom HTTP Search API`
     - Method: `GET`
     - Endpoint URL: `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch={{query}}&format=json`
     - Capabilities: `Encyclopedic Context, Quick Entity Verification`

2. **Local Ollama Model Connector (`ollama_model`)**
   - Registers a local Ollama server endpoint (e.g., `http://localhost:11434`) and target model name (e.g., `llama3.1:8b` or `qwen2.5:14b`).
   - Clicking **Test Connection** calls `GET <endpoint>/api/tags` from the server and lists all pulled models found on that Ollama instance.

3. **Custom Agent Webhook / Utility (`webhook_tool`)**
   - Connects internal company APIs, FastAPI microservices, or local data gateways via `GET` or `POST`.

4. **External MCP / Tool Server (`mcp_endpoint`)**
   - Tracks external Model Context Protocol or custom tool server URLs for health-checking and workspace documentation.

### Security Rule for Authenticated Custom Endpoints
Never paste raw API keys or bearer secrets into the browser UI. If your custom endpoint requires an `Authorization: Bearer ...` header:
1. Add the secret to your server `.env` file (for example: `MY_INTERNAL_API_TOKEN="secret_value"`).
2. In the website's **Auth Env Variable Name (Optional)** field, enter only the variable *name* (`MY_INTERNAL_API_TOKEN`).
3. The Express backend reads `process.env[tool.authEnvVar]` server-side when executing or testing the tool.

---

## 3. Running Orchestra AI Locally with Ollama (Step-by-Step)

**Yes — Orchestra AI supports local Ollama models out of the box** when you run the backend on your own machine or in Docker.

> **Important Note on Cloud Preview vs. Local Hosting:**
> When viewing Orchestra AI inside a hosted cloud preview, the cloud server cannot connect directly to `http://localhost:11434` on your personal computer (unless exposed via a secure tunnel). To use Ollama locally, clone/download the project and run it on your machine.

### Step 1: Install Ollama & Pull Models
Install Ollama from [https://ollama.com](https://ollama.com), then pull a strong structured-JSON reasoning model and an embedding model:

```bash
# Recommended reasoning models (pick one based on your RAM/VRAM):
ollama pull llama3.1:8b        # 8 GB+ RAM — good balance of speed and JSON compliance
ollama pull qwen2.5:14b        # 16 GB+ RAM — strongest structured JSON & fact-checking accuracy
ollama pull mistral-nemo       # 12 GB+ RAM — solid long-context synthesis

# Recommended local embedding model for RAG:
ollama pull nomic-embed-text
```

Verify Ollama is running:
```bash
curl http://localhost:11434/api/tags
```

### Step 2: Configure `.env`
Copy `.env.example` to `.env` and switch `LLM_PROVIDER` to `ollama`:

```env
LLM_PROVIDER="ollama"
OLLAMA_BASE_URL="http://localhost:11434"
OLLAMA_MODEL="llama3.1:8b"
OLLAMA_EMBED_MODEL="nomic-embed-text"

# Optional: add Tavily if you also want live web search while using Ollama
# (Gemini Google Search Grounding requires GEMINI_API_KEY, whereas Tavily works independently)
TAVILY_API_KEY=""

JWT_SECRET="your-local-random-secret"
```

### Step 3: Start Orchestra AI Locally
```bash
npm install
npm run dev
```
Open `http://localhost:3000`, sign in, and visit **Tools & APIs** — you will see **Ollama Local Model Backend** active with your chosen model, and you can also register and probe additional Ollama servers from the UI.

### Step 4: Using Ollama with Docker Compose
If running Orchestra AI inside Docker while Ollama runs on your host machine:
```bash
LLM_PROVIDER=ollama OLLAMA_BASE_URL=http://host.docker.internal:11434 OLLAMA_MODEL=llama3.1:8b docker compose up --build
```
On Linux hosts, ensure Ollama listens on `0.0.0.0:11434` (`OLLAMA_HOST=0.0.0.0`) or run the container with `network_mode: host`.
