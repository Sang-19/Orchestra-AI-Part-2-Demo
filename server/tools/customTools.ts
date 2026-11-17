import crypto from 'node:crypto';
import { getDb } from '../db/database';
import { probeOllamaEndpoint } from '../ai/ollamaClient';
import { sanitizeUntrustedText } from '../orchestrator/stateMachine';
import type {
  CustomToolRecord,
  CustomToolType,
  ToolTestResult,
} from '../../src/types/research';

const VALID_TYPES = new Set<CustomToolType>([
  'http_search',
  'ollama_model',
  'webhook_tool',
  'mcp_endpoint',
]);

export interface CustomToolInput {
  name: string;
  toolType: CustomToolType;
  category: string;
  endpointUrl: string;
  httpMethod?: 'GET' | 'POST';
  modelName?: string;
  authEnvVar?: string;
  description: string;
  capabilities: string[];
  enabled?: boolean;
}

export function validateCustomToolInput(input: CustomToolInput): { valid: boolean; error?: string } {
  const name = (input.name ?? '').trim();
  if (name.length < 2 || name.length > 80) {
    return { valid: false, error: 'Tool name must be between 2 and 80 characters.' };
  }
  if (!VALID_TYPES.has(input.toolType)) {
    return { valid: false, error: 'Invalid tool type selected.' };
  }

  const rawUrl = (input.endpointUrl ?? '').trim();
  if (!rawUrl) {
    return { valid: false, error: 'Endpoint URL is required.' };
  }

  try {
    const parsed = new URL(rawUrl.replace(/\{\{query\}\}/g, 'test'));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, error: 'Endpoint URL must start with http:// or https://.' };
    }
  } catch {
    return { valid: false, error: 'Endpoint URL is not a valid URL.' };
  }

  const envVar = (input.authEnvVar ?? '').trim();
  if (envVar && !/^[A-Z][A-Z0-9_]{1,63}$/.test(envVar)) {
    return {
      valid: false,
      error:
        'Environment variable name must be UPPER_SNAKE_CASE (e.g., CUSTOM_SEARCH_TOKEN) — never paste raw API secrets here.',
    };
  }

  if ((input.description ?? '').trim().length < 6) {
    return { valid: false, error: 'Please provide a brief description (at least 6 characters).' };
  }

  return { valid: true };
}

function mapToolRow(row: Record<string, unknown>): CustomToolRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: String(row.name),
    toolType: row.tool_type as CustomToolType,
    category: String(row.category),
    endpointUrl: String(row.endpoint_url),
    httpMethod: row.http_method === 'POST' ? 'POST' : 'GET',
    modelName: String(row.model_name || ''),
    authEnvVar: String(row.auth_env_var || ''),
    description: String(row.description),
    capabilities: JSON.parse(String(row.capabilities_json || '[]')) as string[],
    enabled: Boolean(row.enabled),
    lastTestedAt: (row.last_tested_at as string | null) ?? null,
    lastTestStatus:
      row.last_test_status === 'ok' || row.last_test_status === 'error'
        ? row.last_test_status
        : 'untested',
    lastTestMessage: (row.last_test_message as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function listCustomTools(userId: string): CustomToolRecord[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM custom_tools WHERE user_id = ? ORDER BY created_at DESC`)
    .all(userId) as Array<Record<string, unknown>>;
  return rows.map(mapToolRow);
}

export function getCustomToolById(id: string, userId: string): CustomToolRecord | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM custom_tools WHERE id = ? AND user_id = ?`)
    .get(id, userId) as Record<string, unknown> | undefined;
  return row ? mapToolRow(row) : null;
}

export function createCustomTool(userId: string, input: CustomToolInput): CustomToolRecord {
  const check = validateCustomToolInput(input);
  if (!check.valid) throw new Error(check.error);

  const id = `tool-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const capabilities = (input.capabilities ?? [])
    .map((c) => c.trim())
    .filter(Boolean)
    .slice(0, 8);

  const db = getDb();
  db.prepare(`
    INSERT INTO custom_tools (
      id, user_id, name, tool_type, category, endpoint_url, http_method, model_name,
      auth_env_var, description, capabilities_json, enabled, last_tested_at, last_test_status,
      last_test_message, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'untested', NULL, ?, ?)
  `).run(
    id,
    userId,
    input.name.trim(),
    input.toolType,
    (input.category || 'Custom Integration').trim(),
    input.endpointUrl.trim(),
    input.httpMethod === 'POST' ? 'POST' : 'GET',
    (input.modelName || '').trim(),
    (input.authEnvVar || '').trim(),
    input.description.trim(),
    JSON.stringify(capabilities.length > 0 ? capabilities : ['Custom Endpoint']),
    input.enabled === false ? 0 : 1,
    now,
    now
  );

  return getCustomToolById(id, userId)!;
}

export function updateCustomTool(
  id: string,
  userId: string,
  patch: Partial<CustomToolInput>
): CustomToolRecord {
  const existing = getCustomToolById(id, userId);
  if (!existing) throw new Error('Custom tool not found.');

  const merged: CustomToolInput = {
    name: patch.name ?? existing.name,
    toolType: patch.toolType ?? existing.toolType,
    category: patch.category ?? existing.category,
    endpointUrl: patch.endpointUrl ?? existing.endpointUrl,
    httpMethod: patch.httpMethod ?? existing.httpMethod,
    modelName: patch.modelName ?? existing.modelName,
    authEnvVar: patch.authEnvVar ?? existing.authEnvVar,
    description: patch.description ?? existing.description,
    capabilities: patch.capabilities ?? existing.capabilities,
    enabled: patch.enabled ?? existing.enabled,
  };

  const check = validateCustomToolInput(merged);
  if (!check.valid) throw new Error(check.error);

  const now = new Date().toISOString();
  const db = getDb();
  db.prepare(`
    UPDATE custom_tools
    SET name = ?, tool_type = ?, category = ?, endpoint_url = ?, http_method = ?,
        model_name = ?, auth_env_var = ?, description = ?, capabilities_json = ?,
        enabled = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(
    merged.name.trim(),
    merged.toolType,
    merged.category.trim(),
    merged.endpointUrl.trim(),
    merged.httpMethod === 'POST' ? 'POST' : 'GET',
    (merged.modelName || '').trim(),
    (merged.authEnvVar || '').trim(),
    merged.description.trim(),
    JSON.stringify(merged.capabilities.map((c) => c.trim()).filter(Boolean).slice(0, 8)),
    merged.enabled ? 1 : 0,
    now,
    id,
    userId
  );

  return getCustomToolById(id, userId)!;
}

export function deleteCustomTool(id: string, userId: string): boolean {
  const db = getDb();
  const info = db
    .prepare(`DELETE FROM custom_tools WHERE id = ? AND user_id = ?`)
    .run(id, userId);
  return info.changes > 0;
}

export async function testCustomToolConnection(
  id: string,
  userId: string
): Promise<{ tool: CustomToolRecord; result: ToolTestResult }> {
  const tool = getCustomToolById(id, userId);
  if (!tool) throw new Error('Custom tool not found.');

  const started = Date.now();
  let result: ToolTestResult;

  if (tool.toolType === 'ollama_model') {
    const probe = await probeOllamaEndpoint(tool.endpointUrl);
    result = {
      ok: probe.ok,
      statusCode: probe.statusCode,
      latencyMs: Date.now() - started,
      message: probe.message,
      details: probe.models.slice(0, 8),
    };
  } else {
    const resolvedUrl = tool.endpointUrl.replace(/\{\{query\}\}/g, encodeURIComponent('test'));
    const headers: Record<string, string> = {
      Accept: 'application/json, text/plain, */*',
    };
    if (tool.authEnvVar && process.env[tool.authEnvVar]) {
      headers.Authorization = `Bearer ${process.env[tool.authEnvVar]}`;
    }

    try {
      const response = await fetch(resolvedUrl, {
        method: tool.httpMethod,
        headers,
        body:
          tool.httpMethod === 'POST' ? JSON.stringify({ query: 'health_check' }) : undefined,
        signal: AbortSignal.timeout(7000),
      });
      result = {
        ok: response.ok,
        statusCode: response.status,
        latencyMs: Date.now() - started,
        message: response.ok
          ? `Endpoint reachable (HTTP ${response.status}).`
          : `Endpoint returned HTTP ${response.status}.`,
      };
    } catch (err) {
      result = {
        ok: false,
        statusCode: null,
        latencyMs: Date.now() - started,
        message: `Connection failed: ${err instanceof Error ? err.message : 'network error'}`,
      };
    }
  }

  const now = new Date().toISOString();
  const db = getDb();
  db.prepare(`
    UPDATE custom_tools
    SET last_tested_at = ?, last_test_status = ?, last_test_message = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(now, result.ok ? 'ok' : 'error', result.message, now, id, userId);

  return {
    tool: getCustomToolById(id, userId)!,
    result,
  };
}

/**
 * Invokes enabled user-created HTTP search/data tools during research execution.
 * Returned payloads are treated strictly as untrusted data and sanitized.
 */
export async function queryEnabledCustomSearchTools(params: {
  userId: string;
  query: string;
}): Promise<Array<{ toolName: string; title: string; url: string; domain: string; snippet: string }>> {
  const tools = listCustomTools(params.userId).filter(
    (t) => t.enabled && (t.toolType === 'http_search' || t.toolType === 'webhook_tool')
  );
  if (tools.length === 0) return [];

  const results: Array<{
    toolName: string;
    title: string;
    url: string;
    domain: string;
    snippet: string;
  }> = [];

  for (const tool of tools.slice(0, 3)) {
    try {
      const targetUrl = tool.endpointUrl.replace(
        /\{\{query\}\}/g,
        encodeURIComponent(params.query)
      );
      const headers: Record<string, string> = {
        Accept: 'application/json, text/plain, */*',
      };
      if (tool.authEnvVar && process.env[tool.authEnvVar]) {
        headers.Authorization = `Bearer ${process.env[tool.authEnvVar]}`;
      }
      if (tool.httpMethod === 'POST') {
        headers['Content-Type'] = 'application/json';
      }

      const res = await fetch(targetUrl, {
        method: tool.httpMethod,
        headers,
        body: tool.httpMethod === 'POST' ? JSON.stringify({ query: params.query }) : undefined,
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;

      const text = await res.text();
      const cleaned = sanitizeUntrustedText(text, 1200);
      if (!cleaned) continue;

      let domain = 'custom-tool';
      try {
        domain = new URL(targetUrl).hostname;
      } catch {
        // fallback
      }

      results.push({
        toolName: tool.name,
        title: `${tool.name}: ${params.query}`,
        url: targetUrl,
        domain,
        snippet: cleaned,
      });
    } catch {
      // Do not fail the full research run if an optional user endpoint times out
    }
  }

  return results;
}
