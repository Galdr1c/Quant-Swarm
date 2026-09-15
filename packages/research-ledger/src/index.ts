import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CandidateEvent, ValidationVerdict } from "@quant-swarm/shared";

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
  confidence: number;
  provenance: ResearchTrialProvenance;
  metrics: ResearchTrialMetrics;
  validationVerdict?: ValidationVerdict;
  tags?: string[];
}

export interface ResearchLedger {
  append(record: ResearchTrialRecord): Promise<void>;
  list(runId?: string): Promise<ResearchTrialRecord[]>;
}

export class MemoryResearchLedger implements ResearchLedger {
  private readonly records: ResearchTrialRecord[] = [];

  async append(record: ResearchTrialRecord): Promise<void> {
    validateRecord(record);
    this.records.push(structuredClone(record));
  }

  async list(runId?: string): Promise<ResearchTrialRecord[]> {
    return this.records
      .filter((record) => runId === undefined || record.runId === runId)
      .map((record) => structuredClone(record));
  }
}

/**
 * Append-only JSONL ledger suitable for a single research worker/process.
 *
 * The file intentionally contains research metadata and numeric evidence only.
 * API keys, auth headers, raw provider requests and hidden reasoning must never
 * be written to this store.
 */
export class JsonlResearchLedger implements ResearchLedger {
  constructor(private readonly filePath: string) {
    if (!filePath.trim()) throw new Error("Research ledger file path cannot be empty");
  }

  async append(record: ResearchTrialRecord): Promise<void> {
    validateRecord(record);
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
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
    return result;
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

export function createTrialRecord(input: Omit<ResearchTrialRecord, "schemaVersion">): ResearchTrialRecord {
  const record: ResearchTrialRecord = { schemaVersion: 1, ...input };
  validateRecord(record);
  return record;
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
  if (!Number.isFinite(record.createdAt) || Number(record.createdAt) <= 0) {
    throw new Error("createdAt must be a positive timestamp");
  }
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
