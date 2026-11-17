import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { chunkText, computeContentHash, computeDeterministicEmbedding } from '../rag/chunker';
import type {
  ClaimRecord,
  ContradictionRecord,
  GroundednessResult,
  QualityEvaluation,
  ResearchPlan,
  ResearchReport,
  SourceRecord,
  WorkflowCheckpoint,
} from '../../src/types/research';
import { renderReportMarkdown } from '../orchestrator/stateMachine';

let dbInstance: Database.Database | null = null;

export function getDb(customPath?: string): Database.Database {
  if (dbInstance && !customPath) return dbInstance;

  const dbPath =
    customPath ?? process.env.DATABASE_PATH ?? path.resolve(process.cwd(), 'data', 'orchestra.db');
  const dir = path.dirname(dbPath);
  if (dbPath !== ':memory:' && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  initializeSchema(db);

  if (!customPath) {
    dbInstance = db;
    recoverInterruptedSessions(db);
    seedDemoWorkspace(db);
  }

  return db;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

function initializeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'researcher',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      default_mode TEXT NOT NULL DEFAULT 'standard',
      max_retries INTEGER NOT NULL DEFAULT 2,
      groundedness_threshold REAL NOT NULL DEFAULT 0.75,
      citation_style TEXT NOT NULL DEFAULT 'numeric',
      report_tone TEXT NOT NULL DEFAULT 'executive',
      include_web_default INTEGER NOT NULL DEFAULT 1,
      include_rag_default INTEGER NOT NULL DEFAULT 1,
      notify_on_complete INTEGER NOT NULL DEFAULT 1,
      notify_on_failure INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS collections (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      collection_id TEXT REFERENCES collections(id) ON DELETE SET NULL,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'processing',
      chunk_count INTEGER NOT NULL DEFAULT 0,
      char_count INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id);
    CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection_id);

    CREATE TABLE IF NOT EXISTS document_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      collection_id TEXT REFERENCES collections(id) ON DELETE SET NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      token_estimate INTEGER NOT NULL,
      metadata_json TEXT NOT NULL,
      embedding_json TEXT NOT NULL,
      embedding_model TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_user ON document_chunks(user_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_doc ON document_chunks(document_id);

    CREATE TABLE IF NOT EXISTS research_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'standard',
      status TEXT NOT NULL DEFAULT 'planning',
      include_web INTEGER NOT NULL DEFAULT 1,
      include_rag INTEGER NOT NULL DEFAULT 1,
      collection_ids_json TEXT NOT NULL DEFAULT '[]',
      max_retries INTEGER NOT NULL DEFAULT 2,
      retry_count INTEGER NOT NULL DEFAULT 0,
      current_agent TEXT,
      plan_json TEXT,
      checkpoint_json TEXT,
      report_json TEXT,
      groundedness_json TEXT,
      quality_json TEXT,
      error_message TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON research_sessions(user_id);

    CREATE TABLE IF NOT EXISTS execution_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      agent_id TEXT,
      message TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_session_seq ON execution_events(session_id, seq);

    CREATE TABLE IF NOT EXISTS session_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      citations_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON session_messages(session_id);
  `);
}

function recoverInterruptedSessions(db: Database.Database): void {
  const now = new Date().toISOString();
  const running = db
    .prepare(`SELECT id FROM research_sessions WHERE status = 'running'`)
    .all() as Array<{ id: string }>;

  if (running.length === 0) return;

  const updateStmt = db.prepare(
    `UPDATE research_sessions SET status = 'paused', updated_at = ? WHERE id = ?`
  );
  const maxSeqStmt = db.prepare(
    `SELECT COALESCE(MAX(seq), 0) as maxSeq FROM execution_events WHERE session_id = ?`
  );
  const insertEventStmt = db.prepare(`
    INSERT INTO execution_events (id, session_id, seq, event_type, agent_id, message, payload_json, created_at)
    VALUES (?, ?, ?, 'execution_paused', NULL, ?, NULL, ?)
  `);

  for (const row of running) {
    updateStmt.run(now, row.id);
    const seqRow = maxSeqStmt.get(row.id) as { maxSeq: number };
    insertEventStmt.run(
      `evt-recover-${row.id}-${Date.now()}`,
      row.id,
      seqRow.maxSeq + 1,
      'Execution paused after server restart; durable checkpoint preserved for resumption.',
      now
    );
  }
}

function seedDemoWorkspace(db: Database.Database): void {
  const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get('researcher@orchestra.ai');
  if (existing) return;

  const now = new Date().toISOString();
  const earlier = new Date(Date.now() - 1000 * 60 * 48).toISOString();
  const userId = 'usr-demo-researcher';
  const passwordHash = bcrypt.hashSync('Orchestra2026!', 10);

  db.prepare(`
    INSERT INTO users (id, email, name, password_hash, role, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'researcher', ?, ?)
  `).run(userId, 'researcher@orchestra.ai', 'Dr. Elena Vance', passwordHash, earlier, now);

  db.prepare(`
    INSERT INTO user_settings (user_id, default_mode, max_retries, groundedness_threshold, citation_style, report_tone, include_web_default, include_rag_default, notify_on_complete, notify_on_failure, updated_at)
    VALUES (?, 'standard', 2, 0.75, 'numeric', 'executive', 1, 1, 1, 1, ?)
  `).run(userId, now);

  const colId = 'col-demo-energy';
  db.prepare(`
    INSERT INTO collections (id, user_id, name, description, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    colId,
    userId,
    'Grid & Battery Briefings',
    'Internal technical memoranda on utility-scale battery chemistry, LFP supply chains, and grid storage economics.',
    earlier
  );

  const docText = [
    'Utility-Scale Lithium Iron Phosphate (LFP) Battery Storage Memorandum — Q4 Technical Briefing.',
    'LFP cathode chemistry eliminates cobalt and nickel dependencies, reducing thermal runaway propagation risk compared to NMC-811 cells in stationary grid enclosures.',
    'Recent field telemetry from 4-hour utility installations indicates cycle life exceeding 6,000 cycles at 80% depth of discharge when operated with liquid-cooled thermal management.',
    'Levelized cost of storage (LCOS) for 4-hour LFP systems declined 28% between 2023 and 2025 due to cell pack oversupply and containerization density reaching 5 MWh per 20-foot ISO unit.',
    'However, sodium-ion stationary cells remain under pilot validation for cold-climate substations (-20C), where LFP charge acceptance requires auxiliary pre-heating.',
  ].join('\n\n');

  const docId = 'doc-demo-lfp-brief';
  const docHash = computeContentHash(docText);
  const chunks = chunkText(docText, { chunkSize: 450, overlap: 80 });

  db.prepare(`
    INSERT INTO documents (id, user_id, collection_id, filename, mime_type, file_size, content_hash, status, chunk_count, char_count, error_message, created_at)
    VALUES (?, ?, ?, ?, 'text/markdown', ?, ?, 'indexed', ?, ?, NULL, ?)
  `).run(docId, userId, colId, 'lfp_grid_storage_briefing.md', docText.length, docHash, chunks.length, docText.length, earlier);

  const insertChunk = db.prepare(`
    INSERT INTO document_chunks (id, document_id, user_id, collection_id, chunk_index, content, token_estimate, metadata_json, embedding_json, embedding_model, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'deterministic-v1', ?)
  `);

  for (const ch of chunks) {
    const emb = computeDeterministicEmbedding(ch.content);
    insertChunk.run(
      `chk-demo-${ch.index}`,
      docId,
      userId,
      colId,
      ch.index,
      ch.content,
      ch.tokenEstimate,
      JSON.stringify({ filename: 'lfp_grid_storage_briefing.md', charStart: ch.charStart, charEnd: ch.charEnd }),
      JSON.stringify(emb),
      earlier
    );
  }

  // Seed 1 rich completed research session with full evidence, contradiction, and report
  const sessionId = 'res-demo-grid-storage';
  const plan: ResearchPlan = {
    objective: 'Compare LFP and sodium-ion chemistries for utility-scale 4-hour grid storage deployment through 2027.',
    methodologyNote: 'Cross-reference internal engineering memoranda with energy storage benchmark publications and evaluate safety, LCOS, and cold-climate performance.',
    subtopics: [
      {
        id: 'sub-1',
        title: 'Thermal Safety and Cycle Longevity',
        description: 'Assess thermal runaway thresholds and cycle degradation across LFP and sodium-ion packs.',
        searchQueries: ['LFP vs sodium-ion grid storage cycle life thermal safety'],
        requiredInformation: ['Cycle life at 80% DoD', 'Thermal runaway onset temperatures'],
        priority: 'high',
      },
      {
        id: 'sub-2',
        title: 'Levelized Cost of Storage and Supply Chain',
        description: 'Compare 2024-2026 pack capex and LCOS trajectories.',
        searchQueries: ['utility scale LFP LCOS 2025 2026 benchmark'],
        requiredInformation: ['Pack cost per kWh', 'Container energy density'],
        priority: 'high',
      },
      {
        id: 'sub-3',
        title: 'Cold-Climate Operating Envelope',
        description: 'Evaluate low-temperature charge acceptance and auxiliary load penalties.',
        searchQueries: ['sodium-ion vs LFP cold climate performance -20C'],
        requiredInformation: ['Sub-zero discharge efficiency', 'Pre-heating overhead'],
        priority: 'medium',
      },
    ],
    potentialDifficulties: [
      'Sodium-ion field data beyond 2,000 cycles remains sparse compared to commercial LFP deployments.',
    ],
    estimatedCycles: 1,
  };

  const sources: SourceRecord[] = [
    {
      id: 'src-1',
      citationNumber: 1,
      title: 'lfp_grid_storage_briefing.md (Knowledge Base)',
      url: 'kb://doc-demo-lfp-brief',
      domain: 'Internal Knowledge Base',
      snippet: '4-hour LFP installations indicate cycle life exceeding 6,000 cycles at 80% DoD with liquid cooling; LCOS declined 28% between 2023 and 2025.',
      publishedAt: '2026-02-15',
      sourceType: 'document',
      subtopicId: 'sub-1',
      credibilityScore: 0.92,
      credibilityTier: 'primary',
      credibilityReasoning: 'Internal engineering memorandum grounded in field telemetry from commissioned 4-hour installations.',
      isOutdated: false,
      isDuplicate: false,
    },
    {
      id: 'src-2',
      citationNumber: 2,
      title: 'IEA Grid-Scale Storage Technology Review',
      url: 'https://www.iea.org/energy-system/electricity/grid-scale-storage',
      domain: 'iea.org',
      snippet: 'LFP accounted for over 85% of new stationary lithium-ion installations globally due to lower material cost and zero cobalt reliance.',
      publishedAt: '2026-01-20',
      sourceType: 'web',
      subtopicId: 'sub-2',
      credibilityScore: 0.95,
      credibilityTier: 'primary',
      credibilityReasoning: 'Intergovernmental energy agency statistical synthesis.',
      isOutdated: false,
      isDuplicate: false,
    },
    {
      id: 'src-3',
      citationNumber: 3,
      title: 'Cold-Weather Stationary Chemistry Trials (NREL Benchmark)',
      url: 'https://www.nrel.gov/grid/energy-storage-cold-climate',
      domain: 'nrel.gov',
      snippet: 'Sodium-ion prototypes retained 86% capacity at -20C without resistive heating, whereas commercial LFP enclosures required 4-7% parasitic heating load.',
      publishedAt: '2025-11-10',
      sourceType: 'web',
      subtopicId: 'sub-3',
      credibilityScore: 0.91,
      credibilityTier: 'primary',
      credibilityReasoning: 'Peer-reviewed national laboratory hardware benchmark.',
      isOutdated: false,
      isDuplicate: false,
    },
  ];

  const claims: ClaimRecord[] = [
    {
      id: 'clm-1',
      statement: 'Liquid-cooled 4-hour LFP installations achieve over 6,000 cycles at 80% depth of discharge.',
      category: 'fact',
      subtopicId: 'sub-1',
      sourceId: 'src-1',
      supportingPassage: 'Recent field telemetry from 4-hour utility installations indicates cycle life exceeding 6,000 cycles at 80% depth of discharge when operated with liquid-cooled thermal management.',
      publishedAt: '2026-02-15',
      verificationStatus: 'supported',
      confidenceScore: 0.94,
      verificationReasoning: 'Directly corroborated by internal field telemetry memorandum.',
    },
    {
      id: 'clm-2',
      statement: 'LFP accounted for more than 85% of newly commissioned stationary lithium-ion storage capacity.',
      category: 'fact',
      subtopicId: 'sub-2',
      sourceId: 'src-2',
      supportingPassage: 'LFP accounted for over 85% of new stationary lithium-ion installations globally due to lower material cost and zero cobalt reliance.',
      publishedAt: '2026-01-20',
      verificationStatus: 'supported',
      confidenceScore: 0.95,
      verificationReasoning: 'Confirmed in IEA technology review statistics.',
    },
    {
      id: 'clm-3',
      statement: 'Sodium-ion cells outperform LFP at -20C without auxiliary heating, though commercial cost parity with 5 MWh LFP containers remains contested.',
      category: 'fact',
      subtopicId: 'sub-3',
      sourceId: 'src-3',
      supportingPassage: 'Sodium-ion prototypes retained 86% capacity at -20C without resistive heating, whereas commercial LFP enclosures required 4-7% parasitic heating load.',
      publishedAt: '2025-11-10',
      verificationStatus: 'conflicting',
      confidenceScore: 0.81,
      verificationReasoning: 'Lab prototypes show strong -20C retention, but commercial capex/LCOS forecasts differ between pilot vendors and LFP containerized benchmarks.',
    },
  ];

  const contradictions: ContradictionRecord[] = [
    {
      id: 'cnt-1',
      topic: 'Cold-Climate Economic Viability of Sodium-Ion vs. Pre-Heated LFP',
      claimAId: 'clm-1',
      claimBId: 'clm-3',
      claimAStatement: '4-hour LFP systems achieved a 28% LCOS reduction via 5 MWh standardized containers.',
      claimBStatement: 'Sodium-ion eliminates 4-7% parasitic thermal heating loads at -20C.',
      summary: 'While sodium-ion demonstrates superior intrinsic sub-zero electrochemistry, current 5 MWh LFP container economies of scale offset the 4-7% heating penalty in most temperate grids.',
      severity: 'moderate',
      resolutionStatus: 'contextual_difference',
      reasoning: 'Performance advantage depends on ambient winter temperature duration; preserved as contextual tradeoff.',
    },
  ];

  const groundedness: GroundednessResult = {
    passed: true,
    score: 0.93,
    totalStatementsChecked: 3,
    unsupportedStatements: [],
    citationIssues: [],
    summary: 'All key claims verified against primary internal documentation and institutional benchmarks.',
  };

  const quality: QualityEvaluation = {
    completenessScore: 0.91,
    evidenceCoverage: 0.93,
    missingSubtopics: [],
    unansweredQuestions: [],
    shouldRetry: false,
    recommendedQueries: [],
    reasoning: 'All three planned subtopics satisfied with primary evidence and explicit tradeoff documentation.',
  };

  const baseReport: Omit<ResearchReport, 'markdownContent'> = {
    title: 'LFP vs. Sodium-Ion for Utility-Scale 4-Hour Grid Storage (2025–2027 Assessment)',
    executiveSummary:
      'Lithium Iron Phosphate (LFP) remains the dominant commercial baseline for 4-hour utility-scale storage, capturing over 85% of new stationary lithium-ion deployments [2] while achieving >6,000 cycles at 80% depth of discharge [1]. Sodium-ion cells offer compelling sub-zero (-20C) retention without parasitic heating [3], positioning them as a targeted complement for extreme cold-climate substations rather than an immediate broad-market replacement.',
    introduction:
      'Grid operators scaling 4-hour duration storage face dual pressures: lowering levelized cost of storage (LCOS) while ensuring thermal safety and reliability across varied climates.',
    researchObjectives: [
      'Quantify commercial cycle life and thermal safety profiles of LFP vs. sodium-ion stationary systems.',
      'Benchmark LCOS reductions driven by 5 MWh containerized LFP supply chains.',
      'Evaluate cold-climate operating envelopes and unresolved economic tradeoffs.',
    ],
    methodology:
      'Multi-agent synthesis combining internal field telemetry memoranda [1] with intergovernmental and national laboratory benchmarks [2][3], followed by claim extraction, source credibility grading, and contradiction preservation.',
    detailedFindings:
      'Containerized LFP deployments benefited from a 28% LCOS reduction between 2023 and 2025 [1], reinforced by elimination of cobalt and nickel [1][2]. Sodium-ion technology demonstrates an 86% capacity retention benchmark at -20C without resistive heating, avoiding the 4–7% parasitic heating load observed in LFP enclosures [3].',
    topicAnalysis: [
      {
        subtopicId: 'sub-1',
        title: 'Thermal Safety and Cycle Longevity',
        summary: 'Liquid-cooled LFP installations deliver >6,000 cycles at 80% DoD with lower thermal propagation risk than NMC-811 [1].',
        keyDiscoveries: ['>6,000 cycles verified in 4-hour field telemetry [1].'],
        knowledgeGaps: ['Multi-year (>5 year) utility field degradation data for sodium-ion remains limited.'],
        citationNumbers: [1],
      },
      {
        subtopicId: 'sub-2',
        title: 'Levelized Cost of Storage and Supply Chain',
        summary: '5 MWh 20-foot ISO containers drove a 28% LCOS drop and >85% market share [1][2].',
        keyDiscoveries: ['LFP leads stationary lithium-ion deployment share above 85% [2].'],
        knowledgeGaps: [],
        citationNumbers: [1, 2],
      },
      {
        subtopicId: 'sub-3',
        title: 'Cold-Climate Operating Envelope',
        summary: 'Sodium-ion retains 86% capacity at -20C without auxiliary pre-heating [3].',
        keyDiscoveries: ['Eliminates 4–7% parasitic heating overhead required by LFP in sub-zero winters [3].'],
        knowledgeGaps: ['Commercial capex parity at gigawatt scale is not yet established.'],
        citationNumbers: [3],
      },
    ],
    evidenceAndCitationsSummary:
      'Three primary sources (one internal telemetry brief and two institutional energy benchmarks) substantiate all core findings with credibility scores between 91% and 95%.',
    contradictoryFindingsSummary:
      'One contextual tradeoff was preserved regarding whether sub-zero efficiency gains in sodium-ion outweigh LFP containerized scale advantages outside extreme winter regions.',
    limitations: [
      'Long-term (>6,000 cycle) commercial sodium-ion grid telemetry is still emerging.',
    ],
    conclusion:
      'Utility procurement teams should retain LFP as the standard 4-hour architecture through 2027 while running targeted cold-climate sodium-ion pilots where sub-zero ambient temperatures persist.',
    generatedAt: earlier,
  };

  const report: ResearchReport = {
    ...baseReport,
    markdownContent: renderReportMarkdown({
      report: baseReport,
      sources,
      contradictions,
      groundedness,
    }),
  };

  const checkpoint: WorkflowCheckpoint = {
    sessionId,
    currentStep: 'quality_evaluator',
    completedAgents: [
      'input_validation',
      'planner',
      'human_approval',
      'research_coordinator',
      'researcher',
      'evidence_extraction',
      'fact_checker',
      'source_credibility',
      'contradiction_checker',
      'summarizer',
      'writer',
      'groundedness_checker',
      'quality_evaluator',
    ],
    retryCount: 0,
    maxRetries: 2,
    plan,
    sources,
    claims,
    contradictions,
    topicSummaries: baseReport.topicAnalysis,
    report,
    groundedness,
    quality,
    lastUpdatedAt: earlier,
  };

  db.prepare(`
    INSERT INTO research_sessions (
      id, user_id, question, mode, status, include_web, include_rag, collection_ids_json,
      max_retries, retry_count, current_agent, plan_json, checkpoint_json, report_json,
      groundedness_json, quality_json, error_message, started_at, completed_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'standard', 'completed', 1, 1, ?, 2, 0, 'quality_evaluator', ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
  `).run(
    sessionId,
    userId,
    'Compare LFP vs. sodium-ion battery architectures for utility-scale 4-hour grid storage deployment through 2027.',
    JSON.stringify([colId]),
    JSON.stringify(plan),
    JSON.stringify(checkpoint),
    JSON.stringify(report),
    JSON.stringify(groundedness),
    JSON.stringify(quality),
    earlier,
    earlier,
    earlier,
    earlier
  );

  const seedEvents = [
    ['execution_started', null, 'Research workflow initialized.'],
    ['agent_completed', 'planner', 'Generated 3-subtopic research plan.'],
    ['agent_completed', 'human_approval', 'Research plan approved by researcher.'],
    ['agent_completed', 'researcher', 'Gathered 3 primary sources across Knowledge Base and web benchmarks.'],
    ['agent_completed', 'fact_checker', 'Verified 3 factual claims against retrieved passages.'],
    ['agent_completed', 'contradiction_checker', 'Preserved 1 contextual tradeoff on cold-climate economics.'],
    ['validation_result', 'groundedness_checker', 'Groundedness check passed (93% support score).'],
    ['execution_completed', 'quality_evaluator', 'Research workflow completed cleanly.'],
  ] as const;

  const insertEvt = db.prepare(`
    INSERT INTO execution_events (id, session_id, seq, event_type, agent_id, message, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
  `);
  seedEvents.forEach(([eventType, agentId, message], i) => {
    insertEvt.run(`evt-demo-${i + 1}`, sessionId, i + 1, eventType, agentId, message, earlier);
  });
}
