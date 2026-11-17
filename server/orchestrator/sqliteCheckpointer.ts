import type { RunnableConfig } from '@langchain/core/runnables';
import {
  BaseCheckpointSaver,
  WRITES_IDX_MAP,
  compareWritesSortKeys,
  writesSortKey,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  type PendingWrite,
} from '@langchain/langgraph-checkpoint';
import { getDb } from '../db/database';

interface CheckpointRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  user_id: string;
  type: string;
  checkpoint_blob: Buffer;
  metadata_blob: Buffer;
}

interface WriteRow {
  task_id: string;
  task_path: string;
  idx: number;
  channel: string;
  type: string;
  value_blob: Buffer;
}

/**
 * Durable SQLite-backed LangGraph checkpointer built on better-sqlite3 WAL storage.
 * Kept strictly separate from RAG document_chunks vector memory.
 *
 * Enforces user-scoped thread isolation whenever `configurable.user_id` is provided:
 * one user cannot read, list, or resume another user's LangGraph thread.
 */
export class SqliteLangGraphSaver extends BaseCheckpointSaver {
  private getDatabase() {
    return getDb();
  }

  private getThreadIdentifiers(config: RunnableConfig): {
    threadId: string;
    checkpointNs: string;
    checkpointId?: string;
    userId?: string;
  } {
    const configurable = (config.configurable ?? {}) as Record<string, unknown>;
    const threadId = typeof configurable.thread_id === 'string' ? configurable.thread_id : '';
    const checkpointNs =
      typeof configurable.checkpoint_ns === 'string' ? configurable.checkpoint_ns : '';
    const checkpointId =
      typeof configurable.checkpoint_id === 'string' ? configurable.checkpoint_id : undefined;
    const userId = typeof configurable.user_id === 'string' ? configurable.user_id : undefined;
    return { threadId, checkpointNs, checkpointId, userId };
  }

  private assertThreadOwnership(threadId: string, userId?: string): void {
    if (!userId || !threadId) return;
    const db = this.getDatabase();
    const existing = db
      .prepare(`SELECT user_id FROM langgraph_checkpoints WHERE thread_id = ? LIMIT 1`)
      .get(threadId) as { user_id: string } | undefined;
    if (existing && existing.user_id !== userId) {
      throw new Error(`Access denied: thread "${threadId}" belongs to another user.`);
    }
  }

  private async loadPendingWrites(
    threadId: string,
    checkpointNs: string,
    checkpointId: string
  ): Promise<CheckpointPendingWrite[]> {
    const db = this.getDatabase();
    const rows = db
      .prepare(
        `SELECT task_id, task_path, idx, channel, type, value_blob
         FROM langgraph_checkpoint_writes
         WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`
      )
      .all(threadId, checkpointNs, checkpointId) as WriteRow[];

    rows.sort((a, b) =>
      compareWritesSortKeys(
        writesSortKey(a.task_path ?? '', a.task_id, a.idx),
        writesSortKey(b.task_path ?? '', b.task_id, b.idx)
      )
    );

    const pendingWrites: CheckpointPendingWrite[] = [];
    for (const row of rows) {
      const value = await this.serde.loadsTyped(row.type, new Uint8Array(row.value_blob));
      pendingWrites.push([row.task_id, row.channel, value]);
    }
    return pendingWrites;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const { threadId, checkpointNs, checkpointId, userId } = this.getThreadIdentifiers(config);
    if (!threadId) return undefined;

    this.assertThreadOwnership(threadId, userId);

    const db = this.getDatabase();
    const row = checkpointId
      ? (db
          .prepare(
            `SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, user_id, type, checkpoint_blob, metadata_blob
             FROM langgraph_checkpoints
             WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`
          )
          .get(threadId, checkpointNs, checkpointId) as CheckpointRow | undefined)
      : (db
          .prepare(
            `SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, user_id, type, checkpoint_blob, metadata_blob
             FROM langgraph_checkpoints
             WHERE thread_id = ? AND checkpoint_ns = ?
             ORDER BY checkpoint_id DESC
             LIMIT 1`
          )
          .get(threadId, checkpointNs) as CheckpointRow | undefined);

    if (!row) return undefined;
    if (userId && row.user_id !== userId) {
      throw new Error(`Access denied: thread "${threadId}" belongs to another user.`);
    }

    const checkpoint = (await this.serde.loadsTyped(
      row.type,
      new Uint8Array(row.checkpoint_blob)
    )) as Checkpoint;
    const metadata = (await this.serde.loadsTyped(
      'json',
      new Uint8Array(row.metadata_blob)
    )) as CheckpointMetadata;
    const pendingWrites = await this.loadPendingWrites(
      row.thread_id,
      row.checkpoint_ns,
      row.checkpoint_id
    );

    const resolvedConfig: RunnableConfig = {
      configurable: {
        thread_id: row.thread_id,
        checkpoint_ns: row.checkpoint_ns,
        checkpoint_id: row.checkpoint_id,
        ...(userId ? { user_id: userId } : {}),
      },
    };

    const parentConfig: RunnableConfig | undefined = row.parent_checkpoint_id
      ? {
          configurable: {
            thread_id: row.thread_id,
            checkpoint_ns: row.checkpoint_ns,
            checkpoint_id: row.parent_checkpoint_id,
            ...(userId ? { user_id: userId } : {}),
          },
        }
      : undefined;

    return {
      config: resolvedConfig,
      checkpoint,
      metadata,
      parentConfig,
      pendingWrites,
    };
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    const { threadId, checkpointNs, userId } = this.getThreadIdentifiers(config);
    if (!threadId) return;

    this.assertThreadOwnership(threadId, userId);

    const db = this.getDatabase();
    const beforeId =
      typeof options?.before?.configurable?.checkpoint_id === 'string'
        ? options.before.configurable.checkpoint_id
        : undefined;

    const params: unknown[] = [threadId, checkpointNs];
    let sql = `
      SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, user_id, type, checkpoint_blob, metadata_blob
      FROM langgraph_checkpoints
      WHERE thread_id = ? AND checkpoint_ns = ?
    `;

    if (userId) {
      sql += ` AND user_id = ?`;
      params.push(userId);
    }
    if (beforeId) {
      sql += ` AND checkpoint_id < ?`;
      params.push(beforeId);
    }

    sql += ` ORDER BY checkpoint_id DESC`;

    const rows = db.prepare(sql).all(...params) as CheckpointRow[];
    let yielded = 0;

    for (const row of rows) {
      const metadata = (await this.serde.loadsTyped(
        'json',
        new Uint8Array(row.metadata_blob)
      )) as CheckpointMetadata;

      if (options?.filter) {
        const matches = Object.entries(options.filter).every(
          ([k, v]) => (metadata as Record<string, unknown>)[k] === v
        );
        if (!matches) continue;
      }

      const checkpoint = (await this.serde.loadsTyped(
        row.type,
        new Uint8Array(row.checkpoint_blob)
      )) as Checkpoint;
      const pendingWrites = await this.loadPendingWrites(
        row.thread_id,
        row.checkpoint_ns,
        row.checkpoint_id
      );

      yield {
        config: {
          configurable: {
            thread_id: row.thread_id,
            checkpoint_ns: row.checkpoint_ns,
            checkpoint_id: row.checkpoint_id,
            ...(userId ? { user_id: userId } : {}),
          },
        },
        checkpoint,
        metadata,
        parentConfig: row.parent_checkpoint_id
          ? {
              configurable: {
                thread_id: row.thread_id,
                checkpoint_ns: row.checkpoint_ns,
                checkpoint_id: row.parent_checkpoint_id,
                ...(userId ? { user_id: userId } : {}),
              },
            }
          : undefined,
        pendingWrites,
      };

      yielded++;
      if (options?.limit && yielded >= options.limit) {
        break;
      }
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions
  ): Promise<RunnableConfig> {
    const { threadId, checkpointNs, checkpointId: parentCheckpointId, userId } =
      this.getThreadIdentifiers(config);
    if (!threadId) {
      throw new Error('SqliteLangGraphSaver.put requires configurable.thread_id.');
    }

    this.assertThreadOwnership(threadId, userId);

    const [type, serializedCheckpoint] = await this.serde.dumpsTyped(checkpoint);
    const [, serializedMetadata] = await this.serde.dumpsTyped(metadata);

    const db = this.getDatabase();
    const effectiveUserId = userId || 'system';

    db.prepare(
      `INSERT OR REPLACE INTO langgraph_checkpoints (
        thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, user_id, type, checkpoint_blob, metadata_blob, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      threadId,
      checkpointNs,
      checkpoint.id,
      parentCheckpointId ?? null,
      effectiveUserId,
      type,
      Buffer.from(serializedCheckpoint),
      Buffer.from(serializedMetadata),
      new Date().toISOString()
    );

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpoint.id,
        ...(userId ? { user_id: userId } : {}),
      },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
    taskPath = ''
  ): Promise<void> {
    const { threadId, checkpointNs, checkpointId, userId } = this.getThreadIdentifiers(config);
    if (!threadId || !checkpointId) {
      throw new Error(
        'SqliteLangGraphSaver.putWrites requires configurable.thread_id and checkpoint_id.'
      );
    }

    this.assertThreadOwnership(threadId, userId);

    const db = this.getDatabase();
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO langgraph_checkpoint_writes (
        thread_id, checkpoint_ns, checkpoint_id, task_id, task_path, idx, channel, type, value_blob
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const serializedRows: Array<{
      idx: number;
      channel: string;
      type: string;
      valueBuf: Buffer;
    }> = [];

    for (let i = 0; i < writes.length; i++) {
      const [channel, value] = writes[i];
      const [type, serializedValue] = await this.serde.dumpsTyped(value);
      const idx = channel in WRITES_IDX_MAP ? WRITES_IDX_MAP[channel] : i;
      serializedRows.push({
        idx,
        channel,
        type,
        valueBuf: Buffer.from(serializedValue),
      });
    }

    const tx = db.transaction(() => {
      for (const item of serializedRows) {
        stmt.run(
          threadId,
          checkpointNs,
          checkpointId,
          taskId,
          taskPath,
          item.idx,
          item.channel,
          item.type,
          item.valueBuf
        );
      }
    });
    tx();
  }

  async deleteThread(threadId: string): Promise<void> {
    const db = this.getDatabase();
    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM langgraph_checkpoint_writes WHERE thread_id = ?`).run(threadId);
      db.prepare(`DELETE FROM langgraph_checkpoints WHERE thread_id = ?`).run(threadId);
    });
    tx();
  }
}

let sharedSaver: SqliteLangGraphSaver | null = null;

export function getSqliteCheckpointer(): SqliteLangGraphSaver {
  if (!sharedSaver) {
    sharedSaver = new SqliteLangGraphSaver();
  }
  return sharedSaver;
}

export function resetSqliteCheckpointer(): void {
  sharedSaver = null;
}
