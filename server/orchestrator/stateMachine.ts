import type {
  AgentId,
  ClaimRecord,
  ContradictionRecord,
  GroundednessResult,
  QualityEvaluation,
  ResearchReport,
  ResearchStatus,
  SourceRecord,
  WorkflowCheckpoint,
} from '../../src/types/research';

export const WORKFLOW_STAGES: AgentId[] = [
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
];

export function validateResearchInput(question: string): { valid: boolean; reason?: string } {
  const trimmed = question.trim();
  if (trimmed.length < 8) {
    return { valid: false, reason: 'Research question must be at least 8 characters long.' };
  }
  if (trimmed.length > 2000) {
    return { valid: false, reason: 'Research question must be 2000 characters or fewer.' };
  }
  const injectionPatterns = [
    /ignore\s+(all\s+)?previous\s+instructions/i,
    /system\s+prompt\s+override/i,
    /reveal\s+your\s+api\s+key/i,
  ];
  for (const pattern of injectionPatterns) {
    if (pattern.test(trimmed)) {
      return {
        valid: false,
        reason: 'Research question contains disallowed instruction-override phrasing.',
      };
    }
  }
  return { valid: true };
}

export function sanitizeUntrustedText(raw: string, maxLength = 8000): string {
  const cleaned = raw
    .replace(/<\/?(system|assistant|instruction|prompt)[^>]*>/gi, '')
    .replace(/\u0000/g, '')
    .trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}...` : cleaned;
}

export function evaluateAdaptiveRetryDecision(params: {
  groundedness: GroundednessResult;
  quality: QualityEvaluation;
  retryCount: number;
  maxRetries: number;
  groundednessThreshold: number;
}): {
  shouldRetry: boolean;
  finalStatus: ResearchStatus;
  reason: string;
} {
  const { groundedness, quality, retryCount, maxRetries, groundednessThreshold } = params;

  const groundednessOk = groundedness.passed && groundedness.score >= groundednessThreshold;
  const qualityOk = quality.completenessScore >= 0.72 && !quality.shouldRetry;

  if (groundednessOk && qualityOk) {
    return {
      shouldRetry: false,
      finalStatus: 'completed',
      reason: 'Groundedness validation and research completeness thresholds satisfied.',
    };
  }

  if (retryCount < maxRetries) {
    const reasons: string[] = [];
    if (!groundednessOk) {
      reasons.push(
        `groundedness score ${Math.round(groundedness.score * 100)}% below threshold ${Math.round(groundednessThreshold * 100)}%`
      );
    }
    if (!qualityOk) {
      reasons.push(
        `completeness score ${Math.round(quality.completenessScore * 100)}% requires deeper coverage`
      );
    }
    return {
      shouldRetry: true,
      finalStatus: 'running',
      reason: `Triggering adaptive retry ${retryCount + 1}/${maxRetries}: ${reasons.join('; ')}.`,
    };
  }

  // Never falsely mark failed validation as successful!
  return {
    shouldRetry: false,
    finalStatus: 'completed_with_warnings',
    reason: `Retry limit (${maxRetries}) reached; report published with explicit groundedness warnings.`,
  };
}

export function computeGroundednessFallback(
  report: ResearchReport,
  claims: ClaimRecord[],
  sources: SourceRecord[],
  threshold: number
): GroundednessResult {
  const validCitations = new Set(sources.map((s) => s.citationNumber));
  const citedMatches = report.markdownContent.match(/\[(\d+)\]/g) ?? [];
  const citationIssues: string[] = [];

  for (const match of citedMatches) {
    const num = Number(match.slice(1, -1));
    if (!validCitations.has(num)) {
      citationIssues.push(`Citation [${num}] does not map to any collected source.`);
    }
  }

  const supportedClaims = claims.filter(
    (c) => c.verificationStatus === 'supported' || c.verificationStatus === 'partially_supported'
  );
  const unsupportedClaims = claims.filter((c) => c.verificationStatus === 'unsupported');

  if (sources.length === 0 || claims.length === 0) {
    return {
      passed: false,
      score: 0,
      totalStatementsChecked: 0,
      unsupportedStatements: ['No verified evidence records were gathered to substantiate the report.'],
      citationIssues,
      summary: 'Groundedness validation failed: zero verified claims or sources.',
    };
  }

  const claimRatio = supportedClaims.length / claims.length;
  const citationBonus = citedMatches.length > 0 && citationIssues.length === 0 ? 0.1 : -0.15;
  const score = Math.max(0, Math.min(1, Number((claimRatio * 0.9 + citationBonus).toFixed(2))));
  const passed = score >= threshold && citationIssues.length === 0 && citedMatches.length > 0;

  return {
    passed,
    score,
    totalStatementsChecked: claims.length,
    unsupportedStatements: unsupportedClaims.slice(0, 5).map((c) => c.statement),
    citationIssues: Array.from(new Set(citationIssues)),
    summary: passed
      ? `Passed groundedness check (${Math.round(score * 100)}% verified support across ${claims.length} claims).`
      : `Groundedness validation flagged ${unsupportedClaims.length} unsupported claims and ${citationIssues.length} citation issues (score ${Math.round(score * 100)}%).`,
  };
}

export function renderReportMarkdown(params: {
  report: Omit<ResearchReport, 'markdownContent'>;
  sources: SourceRecord[];
  contradictions: ContradictionRecord[];
  groundedness: GroundednessResult | null;
}): string {
  const { report, sources, contradictions, groundedness } = params;
  const lines: string[] = [];

  lines.push(`# ${report.title}`);
  lines.push('');
  if (groundedness) {
    lines.push(
      `> **Verification Status:** ${groundedness.passed ? 'Grounded & Verified' : 'Completed with Verification Warnings'} (${Math.round(groundedness.score * 100)}% groundedness score)`
    );
    lines.push('');
  }

  lines.push('## Executive Summary');
  lines.push(report.executiveSummary);
  lines.push('');

  lines.push('## Introduction');
  lines.push(report.introduction);
  lines.push('');

  lines.push('## Research Objectives');
  for (const obj of report.researchObjectives) {
    lines.push(`- ${obj}`);
  }
  lines.push('');

  lines.push('## Methodology');
  lines.push(report.methodology);
  lines.push('');

  lines.push('## Detailed Findings');
  lines.push(report.detailedFindings);
  lines.push('');

  lines.push('## Topic-Wise Analysis');
  for (const topic of report.topicAnalysis) {
    lines.push(`### ${topic.title}`);
    lines.push(topic.summary);
    if (topic.keyDiscoveries.length > 0) {
      lines.push('');
      lines.push('**Key Discoveries:**');
      for (const d of topic.keyDiscoveries) {
        lines.push(`- ${d}`);
      }
    }
    if (topic.knowledgeGaps.length > 0) {
      lines.push('');
      lines.push('**Knowledge Gaps:**');
      for (const g of topic.knowledgeGaps) {
        lines.push(`- ${g}`);
      }
    }
    lines.push('');
  }

  lines.push('## Evidence and Citations');
  lines.push(report.evidenceAndCitationsSummary);
  lines.push('');

  lines.push('## Contradictory Findings');
  lines.push(report.contradictoryFindingsSummary);
  if (contradictions.length > 0) {
    lines.push('');
    for (const c of contradictions) {
      lines.push(`- **${c.topic}** (${c.resolutionStatus}): ${c.summary}`);
    }
  }
  lines.push('');

  lines.push('## Limitations');
  for (const lim of report.limitations) {
    lines.push(`- ${lim}`);
  }
  lines.push('');

  lines.push('## Conclusion');
  lines.push(report.conclusion);
  lines.push('');

  lines.push('## References');
  for (const src of sources) {
    const datePart = src.publishedAt ? ` (${src.publishedAt})` : '';
    lines.push(
      `[${src.citationNumber}] ${src.title}${datePart} — ${src.url} (Credibility: ${src.credibilityTier}, ${Math.round(src.credibilityScore * 100)}%)`
    );
  }

  return lines.join('\n');
}

export function createInitialCheckpoint(sessionId: string, maxRetries: number): WorkflowCheckpoint {
  return {
    sessionId,
    currentStep: 'input_validation',
    completedAgents: [],
    retryCount: 0,
    maxRetries,
    plan: null,
    sources: [],
    claims: [],
    contradictions: [],
    topicSummaries: [],
    report: null,
    groundedness: null,
    quality: null,
    lastUpdatedAt: new Date().toISOString(),
  };
}
