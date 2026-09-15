import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolConfig } from "pg";
import {
  canonicalJson,
  validateRecord,
  validateRunRecord,
  type ResearchAppendResult,
  type ResearchRunFinish,
  type ResearchRunRecord,
  type ResearchTrialRecord,
} from "./index.js";

export interface ResearchRunLease {
  runId: string;
  workerId: string;
  token: string;
  generation: number;
  acquiredAt: number;
  expiresAt: number;
}

export interface ResearchRunLeaseClaim {
  workerId: string;
  now: number;
  leaseMs: number;
}

export interface ResearchRunLeaseHeartbeat {
  now: number;
  leaseMs: number;
}

export interface LeaseCapableResearchLedger {
  claimRunLease(runId: string, claim: ResearchRunLeaseClaim): Promise<ResearchRunLease | undefined>;
  heartbeatRunLease(
    lease: ResearchRunLease,
    heartbeat: ResearchRunLeaseHeartbeat
  ): Promise<ResearchRunLease | undefined>;
  finishRunWithLease(lease: ResearchRunLease, finish: ResearchRunFinish): Promise<void>;
  appendWithLease(
    record: ResearchTrialRecord,
    lease: ResearchRunLease,
    now: number
  ): Promise<ResearchAppendResult>;
  getRun(runId: string): Promise<ResearchRunRecord | undefined>;
  list(runId?: string): Promise<ResearchTrialRecord[]>;
  close?(): Promise<void>;
}

export interface LeasedPostgresResearchLedgerOptions {
  connectionString?: string;
  schema?: string;
  pool?: Pool;
  poolConfig?: Omit<PoolConfig, "connectionString">;
}

/**
 * PostgreSQL research ledger with expiring worker leases and fencing.
 *
 * A stale RUNNING run may be reclaimed only after its lease expires. Every
 * reclaim increments `lease_generation` and issues a fresh random token. Trial
 * writes, heartbeats and terminal transitions require both the token and the
 * generation, so an old worker cannot write after a newer worker has reclaimed
 * the run even if the old process resumes later.
 */
export class LeasedPostgresResearchLedger implements LeaseCapableResearchLedger {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private readonly schema: string;
  private readonly ready: Promise<void>;

  constructor(options: LeasedPostgresResearchLedgerOptions) {
    if (!options.pool && !options.connectionString?.trim()) {
      throw new Error("LeasedPostgresResearchLedger requires connectionString or pool");
    }
    this.schema = validateSqlIdentifier(options.schema ?? "quant_swarm");
    this.ownsPool = !options.pool;
    this.pool = options.pool ?? new Pool({
      ...options.poolConfig,
      connectionString: options.connectionString,
    });
    this.ready = this.initialize();
  }

  async claimRunLease(
    runId: string,
    claim: ResearchRunLeaseClaim
  ): Promise<ResearchRunLease | undefined> {
    validateRunId(runId);
    validateWorkerId(claim.workerId);
    validateTimestamp(claim.now, "claim.now");
    validateLeaseMs(claim.leaseMs);
    await this.ready;

    const token = randomUUID();
    const expiresAt = safeExpiry(claim.now, claim.leaseMs);
    const result = await this.pool.query(
      `INSERT INTO ${this.table("research_runs")} AS existing
        (run_id, created_at_ms, updated_at_ms, status, lease_owner,
         lease_token, lease_generation, lease_expires_at_ms)
       VALUES ($1, $2, $2, 'RUNNING', $3, $4, 1, $5)
       ON CONFLICT (run_id) DO UPDATE
         SET updated_at_ms = EXCLUDED.updated_at_ms,
             status = 'RUNNING',
             lease_owner = EXCLUDED.lease_owner,
             lease_token = EXCLUDED.lease_token,
             lease_generation = existing.lease_generation + 1,
             lease_expires_at_ms = EXCLUDED.lease_expires_at_ms,
             selected_trial_id = NULL,
             error = NULL
       WHERE existing.status = 'RUNNING'
         AND (existing.lease_expires_at_ms IS NULL
              OR existing.lease_expires_at_ms <= EXCLUDED.updated_at_ms)
       RETURNING lease_generation`,
      [runId, claim.now, claim.workerId, token, expiresAt]
    );

    if (result.rowCount !== 1) return undefined;
    const generation = Number(result.rows[0].lease_generation);
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      throw new Error("Postgres returned an invalid lease generation");
    }
    return {
      runId,
      workerId: claim.workerId,
      token,
      generation,
      acquiredAt: claim.now,
      expiresAt,
    };
  }

  async heartbeatRunLease(
    lease: ResearchRunLease,
    heartbeat: ResearchRunLeaseHeartbeat
  ): Promise<ResearchRunLease | undefined> {
    validateLease(lease);
    validateTimestamp(heartbeat.now, "heartbeat.now");
    validateLeaseMs(heartbeat.leaseMs);
    await this.ready;

    const expiresAt = safeExpiry(heartbeat.now, heartbeat.leaseMs);
    const result = await this.pool.query(
      `UPDATE ${this.table("research_runs")}
          SET updated_at_ms = $5,
              lease_expires_at_ms = $6
        WHERE run_id = $1
          AND status = 'RUNNING'
          AND lease_owner = $2
          AND lease_token = $3
          AND lease_generation = $4
          AND lease_expires_at_ms > $5
        RETURNING lease_generation`,
      [
        lease.runId,
        lease.workerId,
        lease.token,
        lease.generation,
        heartbeat.now,
        expiresAt,
      ]
    );
    if (result.rowCount !== 1) return undefined;
    return { ...lease, expiresAt };
  }

  async finishRunWithLease(lease: ResearchRunLease, finish: ResearchRunFinish): Promise<void> {
    validateLease(lease);
    validateFinish(finish);
    await this.ready;

    const result = await this.pool.query(
      `UPDATE ${this.table("research_runs")}
          SET status = $5,
              updated_at_ms = $6,
              selected_trial_id = $7,
              error = $8,
              lease_token = NULL,
              lease_expires_at_ms = NULL
        WHERE run_id = $1
          AND status = 'RUNNING'
          AND lease_owner = $2
          AND lease_token = $3
          AND lease_generation = $4
          AND lease_expires_at_ms > $6
        RETURNING run_id`,
      [
        lease.runId,
        lease.workerId,
        lease.token,
        lease.generation,
        finish.status,
        finish.updatedAt,
        finish.selectedTrialId ?? null,
        finish.error ?? null,
      ]
    );
    if (result.rowCount === 1) return;

    const existing = await this.getRun(lease.runId);
    if (existing && terminalRunMatches(existing, finish)) return;
    throw new Error(`Research run lease lost or expired: ${lease.runId}`);
  }

  async appendWithLease(
    record: ResearchTrialRecord,
    lease: ResearchRunLease,
    now: number
  ): Promise<ResearchAppendResult> {
    validateRecord(record);
    validateLease(lease);
    validateTimestamp(now, "append.now");
    if (record.runId !== lease.runId) {
      throw new Error("Research trial runId does not match lease runId");
    }
    await this.ready;

    const hash = recordHash(record);
    const result = await this.pool.query(
      `INSERT INTO ${this.table("research_trials")}
        (run_id, trial_id, created_at_ms, strategy_id, strategy_fingerprint,
         provider, model, prompt_version, record_hash, record)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb
         FROM ${this.table("research_runs")}
        WHERE run_id = $1
          AND status = 'RUNNING'
          AND lease_owner = $11
          AND lease_token = $12
          AND lease_generation = $13
          AND lease_expires_at_ms > $14
       ON CONFLICT (run_id, trial_id) DO NOTHING
       RETURNING trial_id`,
      [
        record.runId,
        record.trialId,
        record.createdAt,
        record.strategyId,
        record.strategyFingerprint ?? null,
        record.provenance.provider,
        record.provenance.model,
        record.provenance.promptVersion,
        hash,
        JSON.stringify(record),
        lease.workerId,
        lease.token,
        lease.generation,
        now,
      ]
    );
    if (result.rowCount === 1) return "inserted";

    const active = await this.isLeaseActive(lease, now);
    if (!active) throw new Error(`Research run lease lost or expired: ${lease.runId}`);

    const existing = await this.pool.query(
      `SELECT record_hash
         FROM ${this.table("research_trials")}
        WHERE run_id = $1 AND trial_id = $2`,
      [record.runId, record.trialId]
    );
    if (existing.rowCount === 1) {
      if (String(existing.rows[0].record_hash) === hash) return "duplicate";
      throw new Error(`Conflicting research trial already exists: ${record.runId}/${record.trialId}`);
    }
    throw new Error(`Could not append research trial: ${record.runId}/${record.trialId}`);
  }

  async getRun(runId: string): Promise<ResearchRunRecord | undefined> {
    validateRunId(runId);
    await this.ready;
    const result = await this.pool.query(
      `SELECT run_id, created_at_ms, updated_at_ms, status, selected_trial_id, error
         FROM ${this.table("research_runs")}
        WHERE run_id = $1`,
      [runId]
    );
    if (result.rowCount !== 1) return undefined;
    const row = result.rows[0];
    const record: ResearchRunRecord = {
      schemaVersion: 1,
      runId: String(row.run_id),
      createdAt: Number(row.created_at_ms),
      updatedAt: Number(row.updated_at_ms),
      status: row.status,
      ...(row.selected_trial_id ? { selectedTrialId: String(row.selected_trial_id) } : {}),
      ...(row.error ? { error: String(row.error) } : {}),
    };
    validateRunRecord(record);
    return record;
  }

  async list(runId?: string): Promise<ResearchTrialRecord[]> {
    await this.ready;
    const result = runId === undefined
      ? await this.pool.query(
          `SELECT record FROM ${this.table("research_trials")}
            ORDER BY created_at_ms ASC, trial_id ASC`
        )
      : await this.pool.query(
          `SELECT record FROM ${this.table("research_trials")}
            WHERE run_id = $1
            ORDER BY created_at_ms ASC, trial_id ASC`,
          [runId]
        );

    return result.rows.map((row) => {
      const parsed = typeof row.record === "string" ? JSON.parse(row.record) : row.record;
      validateRecord(parsed);
      return parsed as ResearchTrialRecord;
    });
  }

  async close(): Promise<void> {
    await this.ready;
    if (this.ownsPool) await this.pool.end();
  }

  private async isLeaseActive(lease: ResearchRunLease, now: number): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1
         FROM ${this.table("research_runs")}
        WHERE run_id = $1
          AND status = 'RUNNING'
          AND lease_owner = $2
          AND lease_token = $3
          AND lease_generation = $4
          AND lease_expires_at_ms > $5`,
      [lease.runId, lease.workerId, lease.token, lease.generation, now]
    );
    return result.rowCount === 1;
  }

  private async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [`quant-swarm:research-ledger:${this.schema}`]
      );
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.quotedSchema()}`);
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${this.table("research_runs")} (
          run_id TEXT PRIMARY KEY,
          created_at_ms BIGINT NOT NULL,
          updated_at_ms BIGINT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
          selected_trial_id TEXT,
          error TEXT,
          lease_owner TEXT,
          lease_token TEXT,
          lease_generation BIGINT NOT NULL DEFAULT 0,
          lease_expires_at_ms BIGINT
        )`
      );
      await client.query(
        `ALTER TABLE ${this.table("research_runs")}
           ADD COLUMN IF NOT EXISTS lease_owner TEXT,
           ADD COLUMN IF NOT EXISTS lease_token TEXT,
           ADD COLUMN IF NOT EXISTS lease_generation BIGINT NOT NULL DEFAULT 0,
           ADD COLUMN IF NOT EXISTS lease_expires_at_ms BIGINT`
      );
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${this.table("research_trials")} (
          run_id TEXT NOT NULL REFERENCES ${this.table("research_runs")}(run_id) ON DELETE RESTRICT,
          trial_id TEXT NOT NULL,
          created_at_ms BIGINT NOT NULL,
          strategy_id TEXT NOT NULL,
          strategy_fingerprint TEXT,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          prompt_version TEXT NOT NULL,
          record_hash TEXT NOT NULL,
          record JSONB NOT NULL,
          inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (run_id, trial_id)
        )`
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS research_trials_strategy_fingerprint_idx
           ON ${this.table("research_trials")}(strategy_fingerprint)
          WHERE strategy_fingerprint IS NOT NULL`
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS research_trials_strategy_id_idx
           ON ${this.table("research_trials")}(strategy_id)`
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS research_runs_active_lease_idx
           ON ${this.table("research_runs")}(status, lease_expires_at_ms)`
      );
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original migration/bootstrap failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private quotedSchema(): string {
    return `"${this.schema}"`;
  }

  private table(name: "research_runs" | "research_trials"): string {
    return `${this.quotedSchema()}."${name}"`;
  }
}

function validateLease(lease: ResearchRunLease): void {
  validateRunId(lease.runId);
  validateWorkerId(lease.workerId);
  if (!lease.token.trim()) throw new Error("lease.token must be non-empty");
  if (!Number.isSafeInteger(lease.generation) || lease.generation <= 0) {
    throw new Error("lease.generation must be a positive integer");
  }
  validateTimestamp(lease.acquiredAt, "lease.acquiredAt");
  validateTimestamp(lease.expiresAt, "lease.expiresAt");
  if (lease.expiresAt <= lease.acquiredAt) {
    throw new Error("lease.expiresAt must be after lease.acquiredAt");
  }
}

function validateFinish(finish: ResearchRunFinish): void {
  if (finish.status !== "COMPLETED" && finish.status !== "FAILED") {
    throw new Error("finishRun status must be COMPLETED or FAILED");
  }
  validateTimestamp(finish.updatedAt, "finish.updatedAt");
  if (finish.status === "COMPLETED" && !finish.selectedTrialId?.trim()) {
    throw new Error("Completed research run requires selectedTrialId");
  }
  if (finish.error !== undefined && typeof finish.error !== "string") {
    throw new Error("finishRun error must be a string");
  }
}

function terminalRunMatches(current: ResearchRunRecord, finish: ResearchRunFinish): boolean {
  return current.status === finish.status
    && current.updatedAt === finish.updatedAt
    && (current.selectedTrialId ?? undefined) === (finish.selectedTrialId ?? undefined)
    && (current.error ?? undefined) === (finish.error ?? undefined);
}

function recordHash(record: ResearchTrialRecord): string {
  return createHash("sha256").update(canonicalJson(record), "utf8").digest("hex");
}

function validateRunId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error("runId must be non-empty");
  if (value.length > 256) throw new Error("runId must be at most 256 characters");
}

function validateWorkerId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error("workerId must be non-empty");
  if (value.length > 256) throw new Error("workerId must be at most 256 characters");
}

function validateTimestamp(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive timestamp`);
}

function validateLeaseMs(value: number): void {
  if (!Number.isFinite(value) || value < 1_000 || value > 24 * 60 * 60 * 1_000) {
    throw new Error("leaseMs must be between 1000ms and 24h");
  }
}

function safeExpiry(now: number, leaseMs: number): number {
  const expiresAt = now + leaseMs;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    throw new Error("lease expiry is outside the safe timestamp range");
  }
  return expiresAt;
}

function validateSqlIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error("Postgres schema must be a simple SQL identifier");
  }
  return value;
}
