import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Pool, type PoolConfig } from "pg";
import type { CandidateEvent, ValidationVerdict } from "@quant-swarm/shared";
import {
  validateStrategy,
  type StrategyDefinition,
} from "@quant-swarm/strategy-schema";

export interface ResearchTrialMetrics {
  sharpe: number;
  netReturn?: number;
  maxDrawdown?: number;
  profitFactor?: number;
  expectancy?: number;
  pValue?: number;
  /** Explicit out-of-sample returns only. Never substitute in-sample returns. */
  outOfSampleReturns?: number[];
  /** Strategy returns grouped by deterministic market regime. */
  regimeReturns?: Record<string, number[]>;
}

export interface ResearchTrialProvenance {
  provider: string;
  model: string;
  promptVersion: string;
  responseId?: string;
  agentName?: string;
}

export interface ResearchTrialRecord {
  schemaVersion: 1;
  runId: string;
  trialId: string;
  createdAt: number;
  candidate: CandidateEvent;
  strategyId: string;
  /** Canonical SHA-256 of the validated Strategy DSL snapshot. */
  strategyFingerprint?: string;
  /** Exact validated Strategy DSL proposed for this trial. */
  strategySnapshot?: StrategyDefinition;
  confidence: number;
  provenance: ResearchTrialProvenance;
  metrics: ResearchTrialMetrics;
  validationVerdict?: ValidationVerdict;
  tags?: string[];
}

export type ResearchRunStatus = "RUNNING" | "COMPLETED" | "FAILED";

export interface ResearchRunRecord {
  schemaVersion: 1;
  runId: string;
  createdAt: number;
  updatedAt: number;
  status: ResearchRunStatus;
  selectedTrialId?: string;
  error?: string;
}

export interface ResearchRunFinish {
  status: "COMPLETED" | "FAILED";
  updatedAt: number;
  selectedTrialId?: string;
  error?: string;
}

export type ResearchAppendResult = "inserted" | "duplicate";

/**
 * Durable research-ledger contract.
 *
 * `claimRun` is the concurrency boundary. A run id may be claimed once only.
 * `append` is idempotent for an identical `(runId, trialId)` record and rejects
 * conflicting payloads. Implementations used in production must make these
 * operations atomic across workers/processes.
 */
export interface ResearchLedger {
  claimRun(runId: string, createdAt: number): Promise<boolean>;
  finishRun(runId: string, finish: ResearchRunFinish): Promise<void>;
  getRun(runId: string): Promise<ResearchRunRecord | undefined>;
  append(record: ResearchTrialRecord): Promise<ResearchAppendResult>;
  list(runId?: string): Promise<ResearchTrialRecord[]>;
  close?(): Promise<void>;
}

export class MemoryResearchLedger implements ResearchLedger {
  private readonly runs = new Map<string, ResearchRunRecord>();
  private readonly records = new Map<string, ResearchTrialRecord>();

  async claimRun(runId: string, createdAt: number): Promise<boolean> {
    validateRunId(runId);
    validateTimestamp(createdAt, "createdAt");
    if (this.runs.has(runId)) return false;
    this.runs.set(runId, {
      schemaVersion: 1,
      runId,
      createdAt,
      updatedAt: createdAt,
      status: "RUNNING",
    });
    return true;
  }

  async finishRun(runId: string, finish: ResearchRunFinish): Promise<void> {
    const current = this.runs.get(runId);
    if (!current) throw new Error(`Research run was not claimed: ${runId}`);
    const next = finishRunRecord(current, finish);
    this.runs.set(runId, next);
  }

  async getRun(runId: string): Promise<ResearchRunRecord | undefined> {
    const record = this.runs.get(runId);
    return record ? structuredClone(record) : undefined;
  }

  async append(record: ResearchTrialRecord): Promise<ResearchAppendResult> {
    validateRecord(record);
    assertRunWritable(await this.getRun(record.runId), record.runId);
    const key = trialKey(record.runId, record.trialId);
    const existing = this.records.get(key);
    if (existing) {
      if (recordHash(existing) === recordHash(record)) return "duplicate";
      throw new Error(`Conflicting research trial already exists: ${record.runId}/${record.trialId}`);
    }
    this.records.set(key, structuredClone(record));
    return "inserted";
  }

  async list(runId?: string): Promise<ResearchTrialRecord[]> {
    return [...this.records.values()]
      .filter((record) => runId === undefined || record.runId === runId)
      .sort(compareRecords)
      .map((record) => structuredClone(record));
  }
}

/**
 * Append-only JSONL ledger for local development/single-host research.
 *
 * Run claims are persisted in sidecar files using exclusive creation, so the
 * same run id cannot be started twice. Trial appends are idempotent inside the
 * claimed run. For durable multi-worker/cloud deployments use
 * `PostgresResearchLedger`.
 */
export class JsonlResearchLedger implements ResearchLedger {
  private readonly runDir: string;

  constructor(private readonly filePath: string) {
    if (!filePath.trim()) throw new Error("Research ledger file path cannot be empty");
    this.runDir = join(dirname(filePath), `${basename(filePath)}.runs`);
  }

  async claimRun(runId: string, createdAt: number): Promise<boolean> {
    validateRunId(runId);
    validateTimestamp(createdAt, "createdAt");
    await mkdir(this.runDir, { recursive: true });
    const record: ResearchRunRecord = {
      schemaVersion: 1,
      runId,
      createdAt,
      updatedAt: createdAt,
      status: "RUNNING",
    };
    try {
      await writeFile(this.runPath(runId), `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      return true;
    } catch (error: any) {
      if (error?.code === "EEXIST") return false;
      throw error;
    }
  }

  async finishRun(runId: string, finish: ResearchRunFinish): Promise<void> {
    const current = await this.getRun(runId);
    if (!current) throw new Error(`Research run was not claimed: ${runId}`);
    const next = finishRunRecord(current, finish);
    await writeFile(this.runPath(runId), `${JSON.stringify(next)}\n`, "utf8");
  }

  async getRun(runId: string): Promise<ResearchRunRecord | undefined> {
    try {
      const content = await readFile(this.runPath(runId), "utf8");
      const parsed = JSON.parse(content.trim()) as unknown;
      validateRunRecord(parsed);
      const record = parsed as ResearchRunRecord;
      if (record.runId !== runId) throw new Error("Research run sidecar id mismatch");
      return record;
    } catch (error: any) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async append(record: ResearchTrialRecord): Promise<ResearchAppendResult> {
    validateRecord(record);
    assertRunWritable(await this.getRun(record.runId), record.runId);
    const existing = (await this.list(record.runId)).find(
      (row) => row.trialId === record.trialId
    );
    if (existing) {
      if (recordHash(existing) === recordHash(record)) return "duplicate";
      throw new Error(`Conflicting research trial already exists: ${record.runId}/${record.trialId}`);
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
    return "inserted";
  }

  async list(runId?: string): Promise<ResearchTrialRecord[]> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error: any) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }

    const result: ResearchTrialRecord[] = [];
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        throw new Error(`Invalid research-ledger JSON on line ${index + 1}: ${String(error)}`);
      }
      validateRecord(parsed);
      const record = parsed as ResearchTrialRecord;
      if (runId === undefined || record.runId === runId) result.push(record);
    }
    return result.sort(compareRecords);
  }

  private runPath(runId: string): string {
    validateRunId(runId);
    return join(this.runDir, `${sha256(runId)}.json`);
  }
}

export interface PostgresResearchLedgerOptions {
  connectionString?: string;
  schema?: string;
  pool?: Pool;
  poolConfig?: Omit<PoolConfig, "connectionString">;
}

/**
 * Transactional ledger for multi-worker research deployments.
 *
 * Atomic run claims use a primary key on `run_id`. Trial writes use a composite
 * primary key `(run_id, trial_id)` plus a canonical record hash: replaying the
 * exact same trial is a no-op, while a different payload for the same identity
 * is rejected as an integrity conflict. Bootstrap DDL is serialized with a
 * transaction-scoped advisory lock so concurrent cold-start workers cannot race
 * while creating the same schema objects.
 */
export class PostgresResearchLedger implements ResearchLedger {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private readonly schema: string;
  private readonly ready: Promise<void>;

  constructor(options: PostgresResearchLedgerOptions) {
    if (!options.pool && !options.connectionString?.trim()) {
      throw new Error("PostgresResearchLedger requires connectionString or pool");
    }
    this.schema = validateSqlIdentifier(options.schema ?? "quant_swarm");
    this.ownsPool = !options.pool;
    this.pool = options.pool ?? new Pool({
      ...options.poolConfig,
      connectionString: options.connectionString,
    });
    this.ready = this.initialize();
  }

  async claimRun(runId: string, createdAt: number): Promise<boolean> {
    validateRunId(runId);
    validateTimestamp(createdAt, "createdAt");
    await this.ready;
    const result = await this.pool.query(
      `INSERT INTO ${this.table("research_runs")}
        (run_id, created_at_ms, updated_at_ms, status)
       VALUES ($1, $2, $2, 'RUNNING')
       ON CONFLICT (run_id) DO NOTHING
       RETURNING run_id`,
      [runId, createdAt]
    );
    return result.rowCount === 1;
  }

  async finishRun(runId: string, finish: ResearchRunFinish): Promise<void> {
    validateRunId(runId);
    validateFinish(finish);
    await this.ready;
    const result = await this.pool.query(
      `UPDATE ${this.table("research_runs")}
          SET status = $2,
              updated_at_ms = $3,
              selected_trial_id = $4,
              error = $5
        WHERE run_id = $1 AND status = 'RUNNING'
        RETURNING run_id`,
      [
        runId,
        finish.status,
        finish.updatedAt,
        finish.selectedTrialId ?? null,
        finish.error ?? null,
      ]
    );
    if (result.rowCount === 1) return;

    const existing = await this.getRun(runId);
    if (!existing) throw new Error(`Research run was not claimed: ${runId}`);
    if (terminalRunMatches(existing, finish)) return;
    throw new Error(`Research run is already terminal: ${runId} (${existing.status})`);
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
      status: row.status as ResearchRunStatus,
      ...(row.selected_trial_id ? { selectedTrialId: String(row.selected_trial_id) } : {}),
      ...(row.error ? { error: String(row.error) } : {}),
    };
    validateRunRecord(record);
    return record;
  }

  async append(record: ResearchTrialRecord): Promise<ResearchAppendResult> {
    validateRecord(record);
    await this.ready;
    const hash = recordHash(record);
    const result = await this.pool.query(
      `INSERT INTO ${this.table("research_trials")}
        (run_id, trial_id, created_at_ms, strategy_id, strategy_fingerprint,
         provider, model, prompt_version, record_hash, record)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb
         FROM ${this.table("research_runs")}
        WHERE run_id = $1 AND status = 'RUNNING'
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
      ]
    );
    if (result.rowCount === 1) return "inserted";

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

    assertRunWritable(await this.getRun(record.runId), record.runId);
    throw new Error(`Could not append research trial: ${record.runId}/${record.trialId}`);
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
          error TEXT
        )`
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
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original bootstrap failure.
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

export interface PurgedCvEvidence {
  nObservations: number;
  nSplits?: number;
  purgeBars?: number;
  embargoBars?: number;
}

export interface ResearchEvidenceBuildOptions {
  annualization?: number;
  purgedCv?: PurgedCvEvidence;
  cscvBlocks?: number;
  maxCscvCombinations?: number;
}

export interface ResearchValidationEvidence {
  annualization: number;
  trialSharpes: number[];
  candidatePValues?: number[];
  selectedTrialIndex: number;
  cscvReturns?: number[][];
  cscvBlocks?: number;
  maxCscvCombinations?: number;
  regimeReturns?: Record<string, number[]>;
  purgedCv?: PurgedCvEvidence;
}

/**
 * Build `/validate/research` evidence from one strategy-search run.
 *
 * CSCV is emitted only when every trial has a finite OOS return path of the
 * same length. Candidate p-values are emitted only when every trial has one.
 * This prevents incomplete research history from being silently padded or
 * converted into misleading evidence.
 */
export function buildResearchEvidence(
  records: readonly ResearchTrialRecord[],
  selectedTrialId: string,
  options: ResearchEvidenceBuildOptions = {}
): ResearchValidationEvidence {
  if (records.length < 2) {
    throw new Error("Research evidence requires at least two strategy trials");
  }
  const runIds = new Set(records.map((record) => record.runId));
  if (runIds.size !== 1) throw new Error("Research evidence cannot mix different runIds");

  for (const record of records) validateRecord(record);
  const selectedTrialIndex = records.findIndex((record) => record.trialId === selectedTrialId);
  if (selectedTrialIndex < 0) throw new Error(`Selected trial not found: ${selectedTrialId}`);

  const evidence: ResearchValidationEvidence = {
    annualization: positiveFinite(options.annualization, 1),
    trialSharpes: records.map((record) => record.metrics.sharpe),
    selectedTrialIndex,
  };

  const pValues = records.map((record) => record.metrics.pValue);
  if (pValues.every((value) => value !== undefined && finiteProbability(value))) {
    evidence.candidatePValues = pValues as number[];
  }

  const paths = records.map((record) => record.metrics.outOfSampleReturns);
  const pathLength = paths[0]?.length ?? 0;
  if (
    pathLength >= 2 &&
    paths.every(
      (path) =>
        Array.isArray(path) &&
        path.length === pathLength &&
        path.every((value) => Number.isFinite(value))
    )
  ) {
    evidence.cscvReturns = Array.from({ length: pathLength }, (_, observation) =>
      paths.map((path) => path![observation])
    );
    evidence.cscvBlocks = Math.max(4, Math.floor(options.cscvBlocks ?? 8));
    if (evidence.cscvBlocks % 2 !== 0) evidence.cscvBlocks += 1;
    evidence.maxCscvCombinations = Math.max(1, Math.floor(options.maxCscvCombinations ?? 5000));
  }

  const selected = records[selectedTrialIndex];
  if (selected.metrics.regimeReturns) {
    evidence.regimeReturns = structuredClone(selected.metrics.regimeReturns);
  }
  if (options.purgedCv) evidence.purgedCv = { ...options.purgedCv };

  return evidence;
}

export type ResearchTrialRecordInput = Omit<
  ResearchTrialRecord,
  "schemaVersion" | "strategyFingerprint"
> & {
  strategyFingerprint?: string;
};

export function createTrialRecord(input: ResearchTrialRecordInput): ResearchTrialRecord {
  const strategyFingerprint = input.strategySnapshot
    ? input.strategyFingerprint ?? fingerprintStrategy(input.strategySnapshot)
    : input.strategyFingerprint;
  const record: ResearchTrialRecord = {
    schemaVersion: 1,
    ...input,
    ...(strategyFingerprint ? { strategyFingerprint } : {}),
  };
  validateRecord(record);
  return record;
}

export function fingerprintStrategy(strategy: StrategyDefinition): string {
  const validation = validateStrategy(strategy);
  if (!validation.valid || !validation.strategy) {
    throw new Error(`Cannot fingerprint invalid Strategy DSL: ${validation.errors.join("; ")}`);
  }
  return sha256(canonicalJson(validation.strategy));
}

export function validateRecord(value: unknown): asserts value is ResearchTrialRecord {
  if (!value || typeof value !== "object") throw new Error("Research trial must be an object");
  const record = value as Partial<ResearchTrialRecord>;
  if (record.schemaVersion !== 1) throw new Error("Unsupported research trial schemaVersion");
  for (const [name, field] of [
    ["runId", record.runId],
    ["trialId", record.trialId],
    ["strategyId", record.strategyId],
  ] as const) {
    if (typeof field !== "string" || !field.trim()) throw new Error(`${name} must be non-empty`);
  }
  validateTimestamp(Number(record.createdAt), "createdAt");
  if (!record.candidate || typeof record.candidate !== "object") throw new Error("candidate is required");
  if (!record.provenance || typeof record.provenance !== "object") throw new Error("provenance is required");
  if (!record.provenance.provider?.trim()) throw new Error("provenance.provider is required");
  if (!record.provenance.model?.trim()) throw new Error("provenance.model is required");
  if (!record.provenance.promptVersion?.trim()) throw new Error("provenance.promptVersion is required");
  if (!Number.isFinite(record.confidence) || Number(record.confidence) < 0 || Number(record.confidence) > 1) {
    throw new Error("confidence must be in [0, 1]");
  }
  if (!record.metrics || !Number.isFinite(record.metrics.sharpe)) {
    throw new Error("metrics.sharpe must be finite");
  }
  if (record.metrics.pValue !== undefined && !finiteProbability(record.metrics.pValue)) {
    throw new Error("metrics.pValue must be in [0, 1]");
  }
  if (record.metrics.outOfSampleReturns !== undefined) {
    validateReturnPath(record.metrics.outOfSampleReturns, "metrics.outOfSampleReturns");
  }
  if (record.metrics.regimeReturns !== undefined) {
    if (!record.metrics.regimeReturns || typeof record.metrics.regimeReturns !== "object") {
      throw new Error("metrics.regimeReturns must be an object");
    }
    for (const [regime, path] of Object.entries(record.metrics.regimeReturns)) {
      if (!regime.trim()) throw new Error("metrics.regimeReturns keys must be non-empty");
      validateReturnPath(path, `metrics.regimeReturns.${regime}`);
    }
  }

  const hasSnapshot = record.strategySnapshot !== undefined;
  const hasFingerprint = record.strategyFingerprint !== undefined;
  if (hasSnapshot !== hasFingerprint) {
    throw new Error("strategySnapshot and strategyFingerprint must be supplied together");
  }
  if (record.strategySnapshot) {
    const validation = validateStrategy(record.strategySnapshot);
    if (!validation.valid || !validation.strategy) {
      throw new Error(`strategySnapshot is invalid: ${validation.errors.join("; ")}`);
    }
    if (validation.strategy.id !== record.strategyId) {
      throw new Error("strategySnapshot.id must match strategyId");
    }
    const expected = fingerprintStrategy(validation.strategy);
    if (record.strategyFingerprint !== expected) {
      throw new Error("strategyFingerprint does not match strategySnapshot");
    }
  }
}

export function validateRunRecord(value: unknown): asserts value is ResearchRunRecord {
  if (!value || typeof value !== "object") throw new Error("Research run must be an object");
  const record = value as Partial<ResearchRunRecord>;
  if (record.schemaVersion !== 1) throw new Error("Unsupported research run schemaVersion");
  validateRunId(record.runId);
  validateTimestamp(Number(record.createdAt), "createdAt");
  validateTimestamp(Number(record.updatedAt), "updatedAt");
  if (record.updatedAt! < record.createdAt!) throw new Error("updatedAt cannot precede createdAt");
  if (record.status !== "RUNNING" && record.status !== "COMPLETED" && record.status !== "FAILED") {
    throw new Error("Invalid research run status");
  }
  if (record.status === "COMPLETED" && !record.selectedTrialId?.trim()) {
    throw new Error("Completed research run requires selectedTrialId");
  }
  if (record.error !== undefined && typeof record.error !== "string") {
    throw new Error("Research run error must be a string");
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function finishRunRecord(current: ResearchRunRecord, finish: ResearchRunFinish): ResearchRunRecord {
  validateFinish(finish);
  if (current.status !== "RUNNING") {
    if (terminalRunMatches(current, finish)) return structuredClone(current);
    throw new Error(`Research run is already terminal: ${current.runId} (${current.status})`);
  }
  const next: ResearchRunRecord = {
    ...current,
    status: finish.status,
    updatedAt: finish.updatedAt,
    ...(finish.selectedTrialId ? { selectedTrialId: finish.selectedTrialId } : {}),
    ...(finish.error ? { error: finish.error } : {}),
  };
  validateRunRecord(next);
  return next;
}

function validateFinish(finish: ResearchRunFinish): void {
  if (finish.status !== "COMPLETED" && finish.status !== "FAILED") {
    throw new Error("finishRun status must be COMPLETED or FAILED");
  }
  validateTimestamp(finish.updatedAt, "updatedAt");
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

function assertRunWritable(run: ResearchRunRecord | undefined, runId: string): void {
  if (!run) throw new Error(`Research run was not claimed: ${runId}`);
  if (run.status !== "RUNNING") {
    throw new Error(`Research run is not writable: ${runId} (${run.status})`);
  }
}

function validateRunId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error("runId must be non-empty");
  if (value.length > 256) throw new Error("runId must be at most 256 characters");
}

function validateTimestamp(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive timestamp`);
}

function validateReturnPath(path: unknown, name: string): void {
  if (!Array.isArray(path) || !path.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new Error(`${name} must contain only finite numeric returns`);
  }
}

function finiteProbability(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function positiveFinite(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function compareRecords(a: ResearchTrialRecord, b: ResearchTrialRecord): number {
  return a.createdAt - b.createdAt || a.trialId.localeCompare(b.trialId);
}

function trialKey(runId: string, trialId: string): string {
  return `${runId}\u0000${trialId}`;
}

function recordHash(record: ResearchTrialRecord): string {
  return sha256(canonicalJson(record));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      if (input[key] !== undefined) output[key] = canonicalize(input[key]);
    }
    return output;
  }
  return value;
}

function validateSqlIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error("Postgres schema must be a simple SQL identifier");
  }
  return value;
}
