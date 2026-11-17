import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { getDb, closeDb } from '../db/database';
import { createApiRouter } from '../routes/api';

test('API end-to-end: registration, login, user knowledge isolation, collections, RAG ingestion & search, settings', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-test-'));
  process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
  process.env.JWT_SECRET = 'test-secret-key';

  getDb();
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter());

  const server = app.listen(0);
  const address = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}/api`;

  try {
    // 1. Register User A
    const regA = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Alice Researcher',
        email: 'alice@lab.org',
        password: 'Password123!',
      }),
    });
    assert.equal(regA.status, 201);
    const dataA = (await regA.json()) as { token: string; user: { id: string } };
    assert.ok(dataA.token);

    // 2. Register User B
    const regB = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Bob Researcher',
        email: 'bob@lab.org',
        password: 'Password123!',
      }),
    });
    assert.equal(regB.status, 201);
    const dataB = (await regB.json()) as { token: string; user: { id: string } };

    // 3. Create collection for User A
    const colRes = await fetch(`${baseUrl}/collections`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${dataA.token}`,
      },
      body: JSON.stringify({
        name: 'Photovoltaic Materials',
        description: 'Perovskite tandem cell test notes',
      }),
    });
    assert.equal(colRes.status, 201);
    const colData = (await colRes.json()) as { collection: { id: string } };

    // 4. Ingest text document for User A
    const docRes = await fetch(`${baseUrl}/documents/text`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${dataA.token}`,
      },
      body: JSON.stringify({
        title: 'perovskite_stability.md',
        collectionId: colData.collection.id,
        content:
          'Perovskite-silicon tandem solar cells reached 33.9% lab efficiency under AM1.5 illumination, while encapsulation remains critical against moisture ingress.',
      }),
    });
    assert.equal(docRes.status, 201);
    const docData = (await docRes.json()) as { document: { status: string; chunkCount: number } };
    assert.equal(docData.document.status, 'indexed');
    assert.ok(docData.document.chunkCount >= 1);

    // 5. Semantic search for User A returns the document
    const searchA = await fetch(`${baseUrl}/rag/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${dataA.token}`,
      },
      body: JSON.stringify({ query: 'perovskite tandem efficiency' }),
    });
    assert.equal(searchA.status, 200);
    const searchAData = (await searchA.json()) as { matches: Array<{ filename: string }> };
    assert.equal(searchAData.matches.length, 1);
    assert.equal(searchAData.matches[0].filename, 'perovskite_stability.md');

    // 6. User B MUST NOT see User A's document in semantic search (knowledge isolation)
    const searchB = await fetch(`${baseUrl}/rag/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${dataB.token}`,
      },
      body: JSON.stringify({ query: 'perovskite tandem efficiency' }),
    });
    assert.equal(searchB.status, 200);
    const searchBData = (await searchB.json()) as { matches: unknown[] };
    assert.equal(searchBData.matches.length, 0);

    // 7. Settings persistence
    const putSettings = await fetch(`${baseUrl}/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${dataA.token}`,
      },
      body: JSON.stringify({ defaultMode: 'deep', maxRetries: 3, reportTone: 'academic' }),
    });
    assert.equal(putSettings.status, 200);
    const settingsData = (await putSettings.json()) as {
      settings: { defaultMode: string; maxRetries: number; reportTone: string };
    };
    assert.equal(settingsData.settings.defaultMode, 'deep');
    assert.equal(settingsData.settings.maxRetries, 3);
    assert.equal(settingsData.settings.reportTone, 'academic');

    // 8. Dashboard stats match real DB records
    const statsRes = await fetch(`${baseUrl}/dashboard/stats`, {
      headers: { Authorization: `Bearer ${dataA.token}` },
    });
    assert.equal(statsRes.status, 200);
    const statsData = (await statsRes.json()) as {
      stats: { totalDocuments: number; totalCollections: number; totalSessions: number };
    };
    assert.equal(statsData.stats.totalDocuments, 1);
    assert.equal(statsData.stats.totalCollections, 1);
    assert.equal(statsData.stats.totalSessions, 0);

    // 9. User-generated custom tools CRUD & strict user isolation
    const createToolRes = await fetch(`${baseUrl}/tools/custom`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${dataA.token}`,
      },
      body: JSON.stringify({
        name: 'Local Ollama Llama',
        toolType: 'ollama_model',
        category: 'Local LLM',
        endpointUrl: 'http://localhost:11434',
        httpMethod: 'POST',
        modelName: 'llama3.1:8b',
        description: 'Local Ollama connector for self-hosted runs.',
        capabilities: ['Offline Inference', 'JSON Mode'],
        enabled: true,
      }),
    });
    assert.equal(createToolRes.status, 201);
    const createdTool = (await createToolRes.json()) as { tool: { id: string; enabled: boolean } };
    assert.equal(createdTool.tool.enabled, true);

    // User B cannot see or delete User A's custom tool
    const listB = await fetch(`${baseUrl}/tools/custom`, {
      headers: { Authorization: `Bearer ${dataB.token}` },
    });
    const listBData = (await listB.json()) as { customTools: unknown[] };
    assert.equal(listBData.customTools.length, 0);

    const delB = await fetch(`${baseUrl}/tools/custom/${createdTool.tool.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${dataB.token}` },
    });
    assert.equal(delB.status, 404);

    // User A toggles enabled -> false and deletes
    const updateA = await fetch(`${baseUrl}/tools/custom/${createdTool.tool.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${dataA.token}`,
      },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(updateA.status, 200);
    const updatedTool = (await updateA.json()) as { tool: { enabled: boolean } };
    assert.equal(updatedTool.tool.enabled, false);

    const delA = await fetch(`${baseUrl}/tools/custom/${createdTool.tool.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${dataA.token}` },
    });
    assert.equal(delA.status, 200);
  } finally {
    server.close();
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
