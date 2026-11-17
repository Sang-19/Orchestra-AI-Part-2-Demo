import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { AIMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { closeDb, getDb } from '../db/database';
import { createApiRouter } from '../routes/api';
import { createOrchestraLangChainTools } from '../tools/researchTools';
import {
  createOrchestraResearchGraph,
  deduplicateSubtopics,
  type GraphAgentDependencies,
} from '../orchestrator/researchGraph';
import {
  getSqliteCheckpointer,
  resetSqliteCheckpointer,
} from '../orchestrator/sqliteCheckpointer';
import {
  setWorkflowAgentOverrides,
} from '../orchestrator/workflowEngine';
import { renderReportMarkdown } from '../orchestrator/stateMachine';
import { hasGeminiKey } from '../ai/geminiClient';
import type {
  ClaimRecord,
  ContradictionRecord,
  GroundednessResult,
  QualityEvaluation,
  ResearchPlan,
  ResearchReport,
  SourceRecord,
  TopicFindingSection,
} from '../../src/types/research';

function makeMockPlan(suffix = ''): ResearchPlan {
  return {
    objective: `Assess grid-scale battery storage options${suffix}`,
    methodologyNote: 'Cross-reference primary benchmarks and internal memos.',
    subtopics: [
      {
        id: 'sub-1',
        title: 'Cycle Life & Safety',
        description: 'Assess LFP cycle longevity and thermal safety.',
        searchQueries: ['LFP cycle life 80% DoD'],
        requiredInformation: ['Cycle count', 'Thermal profile'],
        priority: 'high',
      },
      {
        id: 'sub-2',
        title: 'Cold Climate Performance',
        description: 'Assess sub-zero discharge retention.',
        searchQueries: ['sodium-ion vs LFP -20C performance'],
        requiredInformation: ['Capacity retention at -20C'],
        priority: 'medium',
      },
    ],
    potentialDifficulties: ['Limited long-term commercial sodium-ion field telemetry.'],
    estimatedCycles: 1,
  };
}

function makeMockAgents(overrides: Partial<GraphAgentDependencies> = {}): GraphAgentDependencies {
  return {
    planner: async ({ feedback }) =>
      makeMockPlan(feedback ? ` (Revised: ${feedback})` : ''),
    subtopicResearcher: async ({ subtopic, startingCitationNumber }) => ({
      sources: [
        {
          id: `src-${subtopic.id}-${startingCitationNumber}`,
          citationNumber: startingCitationNumber,
          title: `Benchmark for ${subtopic.title}`,
          url: `https://example.org/${subtopic.id}/${startingCitationNumber}`,
          domain: 'example.org',
          snippet: `Primary evidence supporting ${subtopic.title} with verified figures.`,
          publishedAt: '2026-02-01',
          sourceType: 'web',
          subtopicId: subtopic.id,
          credibilityScore: 0.9,
          credibilityTier: 'primary',
          credibilityReasoning: 'Institutional benchmark.',
          isOutdated: false,
          isDuplicate: false,
        },
      ],
      gaps: [],
    }),
    evidenceExtractor: async ({ sources }) =>
      sources.map<ClaimRecord>((s, idx) => ({
        id: `clm-${idx + 1}`,
        statement: `Verified finding from ${s.title}`,
        category: 'fact',
        subtopicId: s.subtopicId,
        sourceId: s.id,
        supportingPassage: s.snippet,
        publishedAt: s.publishedAt,
        verificationStatus: 'partially_supported',
        confidenceScore: 0.7,
        verificationReasoning: 'Pending verification.',
      })),
    factChecker: async ({ claims }) =>
      claims.map((c) => ({
        ...c,
        verificationStatus: 'supported',
        confidenceScore: 0.92,
        verificationReasoning: 'Directly supported by quoted passage.',
      })),
    sourceCredibility: async (sources) =>
      sources.map((s) => ({
        ...s,
        credibilityScore: 0.93,
        credibilityTier: 'primary',
        credibilityReasoning: 'Primary technical source.',
      })),
    contradictionChecker: async () => [],
    summarizer: async ({ plan, sources }) =>
      plan.subtopics.map<TopicFindingSection>((st) => ({
        subtopicId: st.id,
        title: st.title,
        summary: `Verified synthesis for ${st.title} [1].`,
        keyDiscoveries: [`Key discovery for ${st.title} [1].`],
        knowledgeGaps: [],
        citationNumbers: sources.filter((s) => s.subtopicId === st.id).map((s) => s.citationNumber),
      })),
    writer: async ({ question, topicSummaries, sources, contradictions, rewriteInstructions }) => {
      const base: Omit<ResearchReport, 'markdownContent'> = {
        title: `Research Report: ${question}`,
        executiveSummary:
          rewriteInstructions && rewriteInstructions.length > 0
            ? 'Rewritten grounded executive summary [1].'
            : 'Grounded executive summary referencing [1].',
        introduction: 'Introduction to grid storage.',
        researchObjectives: ['Compare cycle life', 'Compare cold climate performance'],
        methodology: 'LangGraph multi-agent orchestration.',
        detailedFindings: 'Detailed findings backed by [1] and [2].',
        topicAnalysis: topicSummaries,
        evidenceAndCitationsSummary: `${sources.length} verified sources.`,
        contradictoryFindingsSummary:
          contradictions.length > 0 ? `${contradictions.length} conflicts preserved.` : 'No unresolved conflicts.',
        limitations: ['Limited 5-year sodium-ion telemetry.'],
        conclusion: 'LFP remains baseline through 2027 [1].',
        generatedAt: new Date().toISOString(),
      };
      return {
        ...base,
        markdownContent: renderReportMarkdown({
          report: base,
          sources,
          contradictions,
          groundedness: null,
        }),
      };
    },
    groundednessChecker: async ({ claims }): Promise<GroundednessResult> => ({
      passed: true,
      score: 0.94,
      totalStatementsChecked: claims.length,
      unsupportedStatements: [],
      citationIssues: [],
      summary: 'Groundedness validation passed (94%).',
    }),
    qualityEvaluator: async (): Promise<QualityEvaluation> => ({
      completenessScore: 0.92,
      evidenceCoverage: 0.95,
      missingSubtopics: [],
      unansweredQuestions: [],
      shouldRetry: false,
      recommendedQueries: [],
      reasoning: 'All subtopics thoroughly covered.',
    }),
    ...overrides,
  };
}

function withTempDb<T>(fn: (tmpDir: string) => Promise<T>): Promise<T> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-lg-'));
  const prevDbPath = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = path.join(tmpDir, 'langgraph.db');
  closeDb();
  resetSqliteCheckpointer();
  getDb();

  return fn(tmpDir).finally(() => {
    setWorkflowAgentOverrides(undefined);
    closeDb();
    resetSqliteCheckpointer();
    if (prevDbPath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = prevDbPath;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
}

test('LangGraph ToolNode executes reusable tools separated from agent reasoning', async () => {
  const { toolNode } = createOrchestraLangChainTools({ userId: 'usr-tool-test' });
  const aiMsg = new AIMessage({
    content: '',
    tool_calls: [
      {
        id: 'call_dedup_1',
        name: 'citation_deduplicator',
        args: {
          urls: [
            'https://iea.org/report',
            'HTTPS://IEA.ORG/REPORT',
            'https://nrel.gov/bench',
          ],
        },
      },
    ],
  });

  const result = (await toolNode.invoke({ messages: [aiMsg] })) as {
    messages: Array<{ content: string }>;
  };
  assert.equal(result.messages.length, 1);
  const parsed = JSON.parse(String(result.messages[0].content)) as {
    uniqueCount: number;
    uniqueUrls: string[];
  };
  assert.equal(parsed.uniqueCount, 2);
  assert.deepEqual(parsed.uniqueUrls, ['https://iea.org/report', 'https://nrel.gov/bench']);
});

test('LangGraph human approval interrupt, plan revision feedback, SQLite restart recovery, and user thread isolation', async () => {
  await withTempDb(async () => {
    const threadId = 'res-lg-interrupt-test';
    const userA = 'usr-alice';
    const userB = 'usr-bob';
    let plannerCalls = 0;

    const agents = makeMockAgents({
      planner: async ({ feedback }) => {
        plannerCalls++;
        return makeMockPlan(feedback ? ` [Feedback: ${feedback}]` : '');
      },
    });

    const configA = { configurable: { thread_id: threadId, user_id: userA } };
    const configB = { configurable: { thread_id: threadId, user_id: userB } };

    // 1. Run until human_approval interrupt()
    const graph1 = createOrchestraResearchGraph({ agents, nodeRetryDelayMs: 0 });
    await graph1.invoke(
      {
        sessionId: threadId,
        userId: userA,
        question: 'Compare LFP and sodium-ion battery storage for utility grids',
        mode: 'standard',
        includeWeb: true,
        includeRag: false,
        collectionIds: [],
        maxRetries: 2,
        groundednessThreshold: 0.75,
        reportTone: 'executive',
        citationStyle: 'numeric',
      },
      configA
    );

    const pausedState = await graph1.getState(configA);
    assert.ok(pausedState.next.includes('human_approval'));
    assert.equal(plannerCalls, 1);

    // 2. Simulate full backend restart (close SQLite + reset checkpointer singleton)
    closeDb();
    resetSqliteCheckpointer();
    getDb();

    // 3. Cross-user thread access MUST be denied
    const graphAfterRestart = createOrchestraResearchGraph({ agents, nodeRetryDelayMs: 0 });
    await assert.rejects(
      () => graphAfterRestart.getState(configB),
      /Access denied/i
    );

    // 4. Reject with feedback -> routes back to Planner -> pauses again at human_approval
    await graphAfterRestart.invoke(
      new Command({
        resume: { action: 'revise', feedback: 'Include regulatory compliance' },
      }),
      configA
    );

    const revisedState = await graphAfterRestart.getState(configA);
    assert.ok(revisedState.next.includes('human_approval'));
    assert.equal(plannerCalls, 2);
    assert.match(
      String((revisedState.values as { plan?: ResearchPlan }).plan?.objective ?? ''),
      /Include regulatory compliance/
    );

    // 5. Simulate second backend restart, then approve -> executes full graph to completion
    closeDb();
    resetSqliteCheckpointer();
    getDb();

    const graphFinal = createOrchestraResearchGraph({ agents, nodeRetryDelayMs: 0 });
    const finalState = await graphFinal.invoke(
      new Command({ resume: { action: 'approve' } }),
      configA
    );

    assert.equal(finalState.status, 'completed');
    assert.ok(finalState.report?.markdownContent.includes('Research Report:'));
    assert.ok(finalState.sources.length >= 2);
    assert.ok(finalState.completedAgents.includes('human_approval'));
    assert.ok(finalState.completedAgents.includes('quality_evaluator'));
  });
});

test('LangGraph Send() parallel research enforces deduplication, bounded concurrency, and branch failure isolation', async () => {
  await withTempDb(async () => {
    const duplicatePlan: ResearchPlan = {
      objective: 'Test parallel Send() fan-out',
      methodologyNote: 'Parallel workers',
      subtopics: [
        { id: 's1', title: 'Topic One', description: 'D1', searchQueries: ['q1'], requiredInformation: ['r1'], priority: 'high' },
        { id: 's1', title: 'Topic One', description: 'Duplicate', searchQueries: ['q1'], requiredInformation: ['r1'], priority: 'high' },
        { id: 's2', title: 'Topic Two (Fails)', description: 'D2', searchQueries: ['q2'], requiredInformation: ['r2'], priority: 'high' },
        { id: 's3', title: 'Topic Three', description: 'D3', searchQueries: ['q3'], requiredInformation: ['r3'], priority: 'medium' },
        { id: 's4', title: 'Topic Four', description: 'D4', searchQueries: ['q4'], requiredInformation: ['r4'], priority: 'low' },
      ],
      potentialDifficulties: [],
      estimatedCycles: 1,
    };

    assert.equal(deduplicateSubtopics(duplicatePlan.subtopics).length, 4);

    let activeCount = 0;
    let peakConcurrency = 0;
    const executedIds: string[] = [];

    const agents = makeMockAgents({
      planner: async () => duplicatePlan,
      subtopicResearcher: async ({ subtopic, startingCitationNumber }) => {
        activeCount++;
        peakConcurrency = Math.max(peakConcurrency, activeCount);
        executedIds.push(subtopic.id);
        await new Promise((r) => setTimeout(r, 35));
        activeCount--;

        if (subtopic.id === 's2') {
          throw new Error('Upstream search timeout on s2');
        }
        return {
          sources: [
            {
              id: `src-${subtopic.id}`,
              citationNumber: startingCitationNumber,
              title: `Source for ${subtopic.title}`,
              url: `https://bench.org/${subtopic.id}`,
              domain: 'bench.org',
              snippet: `Evidence for ${subtopic.title}`,
              publishedAt: '2026-01-10',
              sourceType: 'web',
              subtopicId: subtopic.id,
              credibilityScore: 0.9,
              credibilityTier: 'primary',
              credibilityReasoning: 'Verified',
              isOutdated: false,
              isDuplicate: false,
            },
          ],
          gaps: [],
        };
      },
    });

    const graph = createOrchestraResearchGraph({
      agents,
      maxParallelResearch: 2,
      maxNodeAttempts: 1,
      nodeRetryDelayMs: 0,
    });
    const config = { configurable: { thread_id: 'res-lg-parallel', user_id: 'usr-par' } };

    await graph.invoke(
      {
        sessionId: 'res-lg-parallel',
        userId: 'usr-par',
        question: 'Parallel Send concurrency and isolation test',
        mode: 'deep',
        includeWeb: true,
        includeRag: false,
        collectionIds: [],
        maxRetries: 1,
        groundednessThreshold: 0.75,
        reportTone: 'executive',
        citationStyle: 'numeric',
      },
      config
    );

    const finalState = await graph.invoke(
      new Command({ resume: { action: 'approve' } }),
      config
    );

    assert.equal(finalState.status, 'completed');
    assert.equal(executedIds.length, 4, 'Duplicate subtopic must not run twice');
    assert.ok(peakConcurrency >= 2, `Expected parallel execution (>=2), observed ${peakConcurrency}`);
    assert.ok(peakConcurrency <= 2, `Expected bounded concurrency (<=2), observed ${peakConcurrency}`);
    // 3 successful branches should have clean sequential citations 1, 2, 3
    assert.equal(finalState.sources.length, 3);
    assert.deepEqual(
      finalState.sources.map((s) => s.citationNumber),
      [1, 2, 3]
    );
    assert.ok(
      finalState.researchGaps.some((g) => g.includes('Upstream search timeout on s2')),
      'Failed branch error should be recorded in researchGaps without crashing sibling branches'
    );
  });
});

test('LangGraph conditional routing: writer rewrite, research retry, contradiction recheck, and max-retry cap', async () => {
  await withTempDb(async () => {
    // A) Writer rewrite path (evidence solid, report has citation issue -> routes straight to writer without re-searching)
    let researchCalls = 0;
    let writerCalls = 0;
    const rewriteAgents = makeMockAgents({
      subtopicResearcher: async (params) => {
        researchCalls++;
        return makeMockAgents().subtopicResearcher(params);
      },
      writer: async (params) => {
        writerCalls++;
        return makeMockAgents().writer(params);
      },
      groundednessChecker: async ({ claims }) => {
        if (writerCalls === 1) {
          return {
            passed: false,
            score: 0.62,
            totalStatementsChecked: claims.length,
            unsupportedStatements: ['Unverified efficiency projection'],
            citationIssues: ['Citation [99] missing'],
            summary: 'Needs rewrite.',
          };
        }
        return {
          passed: true,
          score: 0.95,
          totalStatementsChecked: claims.length,
          unsupportedStatements: [],
          citationIssues: [],
          summary: 'Passed after rewrite.',
        };
      },
    });

    const rewriteGraph = createOrchestraResearchGraph({ agents: rewriteAgents, nodeRetryDelayMs: 0 });
    const cfgRewrite = { configurable: { thread_id: 'res-lg-rewrite', user_id: 'usr-rt' } };
    await rewriteGraph.invoke(
      {
        sessionId: 'res-lg-rewrite',
        userId: 'usr-rt',
        question: 'Test targeted writer rewrite conditional route',
        mode: 'standard',
        includeWeb: true,
        includeRag: false,
        collectionIds: [],
        maxRetries: 2,
        groundednessThreshold: 0.75,
        reportTone: 'executive',
        citationStyle: 'numeric',
      },
      cfgRewrite
    );
    const rewriteDone = await rewriteGraph.invoke(new Command({ resume: { action: 'approve' } }), cfgRewrite);
    assert.equal(rewriteDone.status, 'completed');
    assert.equal(writerCalls, 2, 'Writer should have rewritten unsupported sections once');
    assert.equal(researchCalls, 2, 'Researcher should NOT re-run when only report rewrite is needed');

    // B) Contradiction recheck + Retry research + Max retry limit cap (no infinite loop!)
    let contradictionCalls = 0;
    let retryResearchCalls = 0;
    const boundedAgents = makeMockAgents({
      subtopicResearcher: async (params) => {
        retryResearchCalls++;
        return makeMockAgents().subtopicResearcher(params);
      },
      contradictionChecker: async ({ claims }): Promise<ContradictionRecord[]> => {
        contradictionCalls++;
        if (claims.length < 2) return [];
        return [
          {
            id: 'cnt-high-1',
            topic: 'Cost parity',
            claimAId: claims[0].id,
            claimBId: claims[1].id,
            claimAStatement: claims[0].statement,
            claimBStatement: claims[1].statement,
            summary: 'Direct conflict on pack cost',
            severity: 'high',
            resolutionStatus: 'unresolved',
            reasoning: 'Needs recheck',
          },
        ];
      },
      groundednessChecker: async ({ claims }) => ({
        passed: false,
        score: 0.55,
        totalStatementsChecked: claims.length,
        unsupportedStatements: [],
        citationIssues: [],
        summary: 'Still below threshold.',
      }),
      qualityEvaluator: async () => ({
        completenessScore: 0.68,
        evidenceCoverage: 0.6,
        missingSubtopics: ['Cold Climate Performance'],
        unansweredQuestions: ['What is exact capex?'],
        shouldRetry: true,
        recommendedQueries: ['utility sodium-ion capex 2026'],
        reasoning: 'Needs deeper evidence',
      }),
    });

    const boundedGraph = createOrchestraResearchGraph({ agents: boundedAgents, nodeRetryDelayMs: 0 });
    const cfgBounded = { configurable: { thread_id: 'res-lg-bounded', user_id: 'usr-rt' } };
    await boundedGraph.invoke(
      {
        sessionId: 'res-lg-bounded',
        userId: 'usr-rt',
        question: 'Test contradiction recheck, research retry, and max retry limit',
        mode: 'standard',
        includeWeb: true,
        includeRag: false,
        collectionIds: [],
        maxRetries: 2,
        groundednessThreshold: 0.75,
        reportTone: 'executive',
        citationStyle: 'numeric',
      },
      cfgBounded
    );
    const boundedDone = await boundedGraph.invoke(new Command({ resume: { action: 'approve' } }), cfgBounded);

    assert.equal(boundedDone.status, 'completed_with_warnings');
    assert.equal(boundedDone.retryCount, 2, 'Must stop cleanly at maxRetries');
    assert.ok(contradictionCalls >= 2, 'Contradiction checker should have been rechecked');
    assert.ok(retryResearchCalls >= 4, 'Researcher should have retried on insufficient evidence');
  });
});

test('End-to-end API + SSE streaming + plan revision + rejection + failure recovery via LangGraph', async () => {
  await withTempDb(async () => {
    process.env.JWT_SECRET = 'lg-e2e-secret';
    let summarizerFailuresRemaining = 0;
    setWorkflowAgentOverrides(
      makeMockAgents({
        summarizer: async (params) => {
          if (summarizerFailuresRemaining > 0) {
            summarizerFailuresRemaining--;
            throw new Error('Simulated persistent API outage in summarizer');
          }
          return makeMockAgents().summarizer(params);
        },
      })
    );

    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter());

    const server = app.listen(0);
    const { port } = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${port}/api`;

    try {
      // Register user
      const reg = await fetch(`${baseUrl}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'LangGraph Tester',
          email: 'lg@orchestra.ai',
          password: 'Password123!',
        }),
      });
      assert.equal(reg.status, 201);
      const { token } = (await reg.json()) as { token: string };
      const authHeaders = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      };

      // 1. Create research -> pauses at human approval
      const createRes = await fetch(`${baseUrl}/research`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          question: 'Evaluate utility LFP vs sodium-ion storage deployments',
          mode: 'standard',
          includeWeb: true,
          includeRag: false,
          maxRetries: 1,
        }),
      });
      assert.equal(createRes.status, 201);
      const created = (await createRes.json()) as {
        session: { id: string; status: string; plan: ResearchPlan };
      };
      assert.equal(created.session.status, 'awaiting_approval');
      assert.ok(created.session.plan.subtopics.length === 2);

      // 2. Revise plan via /reject { revise: true } -> loops back to planner
      const reviseRes = await fetch(`${baseUrl}/research/${created.session.id}/reject`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ reason: 'Add supply chain risk', revise: true }),
      });
      assert.equal(reviseRes.status, 200);
      const revised = (await reviseRes.json()) as {
        session: { status: string; plan: ResearchPlan };
      };
      assert.equal(revised.session.status, 'awaiting_approval');
      assert.match(revised.session.plan.objective, /Add supply chain risk/);

      // 3. Subscribe to SSE stream & approve plan
      const abort = new AbortController();
      const ssePromise = (async () => {
        const res = await fetch(`${baseUrl}/research/${created.session.id}/stream?afterSeq=0`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: abort.signal,
        });
        assert.equal(res.status, 200);
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let collected = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          collected += decoder.decode(value, { stream: true });
          if (collected.includes('event: execution_completed')) {
            abort.abort();
            break;
          }
        }
        return collected;
      })().catch((err) => {
        if ((err as Error).name === 'AbortError') return 'aborted_after_complete';
        throw err;
      });

      const approveRes = await fetch(`${baseUrl}/research/${created.session.id}/approve`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ plan: revised.session.plan }),
      });
      assert.equal(approveRes.status, 200);

      // Wait for completion via polling + SSE
      let completedSession: { status: string; report: ResearchReport | null } | null = null;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 80));
        const getRes = await fetch(`${baseUrl}/research/${created.session.id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = (await getRes.json()) as {
          session: { status: string; report: ResearchReport | null };
        };
        if (data.session.status === 'completed') {
          completedSession = data.session;
          break;
        }
      }
      assert.ok(completedSession, 'Session should complete after LangGraph approval');
      assert.ok(completedSession!.report?.markdownContent.includes('# Research Report:'));
      abort.abort();
      await ssePromise;

      // 4. Reject without revision -> status becomes 'rejected'
      const createRes2 = await fetch(`${baseUrl}/research`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          question: 'Second session to verify hard rejection path',
          mode: 'standard',
          includeWeb: true,
          includeRag: false,
        }),
      });
      const created2 = (await createRes2.json()) as { session: { id: string } };
      const rejectHard = await fetch(`${baseUrl}/research/${created2.session.id}/reject`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ reason: 'Out of scope', revise: false }),
      });
      assert.equal(rejectHard.status, 200);
      const rejectedData = (await rejectHard.json()) as { session: { status: string } };
      assert.equal(rejectedData.session.status, 'rejected');

      // 5. Failure & Checkpoint Resumption via /resume
      summarizerFailuresRemaining = 2;
      const createRes3 = await fetch(`${baseUrl}/research`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          question: 'Third session to test API failure and checkpoint resumption',
          mode: 'standard',
          includeWeb: true,
          includeRag: false,
        }),
      });
      const created3 = (await createRes3.json()) as { session: { id: string } };
      await fetch(`${baseUrl}/research/${created3.session.id}/approve`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({}),
      });

      let failedObserved = false;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 80));
        const getRes = await fetch(`${baseUrl}/research/${created3.session.id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = (await getRes.json()) as { session: { status: string } };
        if (data.session.status === 'failed') {
          failedObserved = true;
          break;
        }
      }
      assert.equal(failedObserved, true, 'Session should fail cleanly on simulated outage');

      const resumeRes = await fetch(`${baseUrl}/research/${created3.session.id}/resume`, {
        method: 'POST',
        headers: authHeaders,
      });
      assert.equal(resumeRes.status, 200);

      let recovered = false;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 80));
        const getRes = await fetch(`${baseUrl}/research/${created3.session.id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = (await getRes.json()) as { session: { status: string } };
        if (data.session.status === 'completed') {
          recovered = true;
          break;
        }
      }
      assert.equal(recovered, true, 'Session should recover from SQLite checkpoint via /resume');

      // Confirm LangGraph checkpointer saved durable checkpoints in SQLite
      const tuple = await getSqliteCheckpointer().getTuple({
        configurable: { thread_id: created.session.id },
      });
      assert.ok(tuple?.checkpoint?.id, 'LangGraph checkpoint must exist in SQLite');
    } finally {
      server.close();
    }
  });
});

test('Gemini integration check: shared client config is intact', () => {
  assert.equal(typeof hasGeminiKey(), 'boolean');
});
