import {
  MultiAgentResearchCoordinator,
  type MultiAgentCoordinatorOptions,
  type ResearchAgent,
  type ResearchContext,
} from "@quant-swarm/ai-orchestrator";
import {
  buildResearchEvidence,
  createTrialRecord,
  type PurgedCvEvidence,
  type ResearchLedger,
  type ResearchTrialRecord,
  type ResearchValidationEvidence,
} from "@quant-swarm/research-ledger";
import type {
  BacktestResult,
  CandidateEvent,
  OHLCV,
  ValidationReport,
} from "@quant-swarm/shared";
import type { StrategyDefinition } from "@quant-swarm/strategy-schema";

export interface BacktestWithEquity extends BacktestResult {
  equityCurve: number[];
  trades?: unknown[];
}

export interface PsrEvidence {
  probability: number;
  pValue: number;
  sharpe: number;
  observations: number;
  benchmarkSharpe: number;
  annualization: number;
}

export interface ResearchQuantClient {
  backtest(strategy: StrategyDefinition, candles: OHLCV[]): Promise<BacktestWithEquity>;
  psr(equityCurve: number[], annualization: number): Promise<PsrEvidence>;
  validateResearch(
    result: BacktestWithEquity,
    evidence: ResearchValidationEvidence
  ): Promise<ValidationReport>;
}

export interface ResearchSearchOptions {
  runId: string;
  annualization?: number;
  minimumSuccessfulTrials?: number;
  coordinator?: MultiAgentCoordinatorOptions;
  purgedCv?: Omit<PurgedCvEvidence, "nObservations">;
}

export interface TrialEvaluation {
  trialId: string;
  agentName: string;
  record: ResearchTrialRecord;
  backtest: BacktestWithEquity;
}

export interface ResearchSearchResult {
  runId: string;
  selectedTrialId: string;
  selectedStrategy: StrategyDefinition;
  trialEvaluations: TrialEvaluation[];
  agentFailures: { agentName: string; message: string; timedOut: boolean }[];
  evaluationFailures: { agentName: string; strategyId: string; message: string }[];
  validationBacktest: BacktestWithEquity;
  finalHoldoutBacktest: BacktestWithEquity;
  evidence: ResearchValidationEvidence;
  researchValidation: ValidationReport;
}

type EvaluationOutcome =
  | { ok: true; index: number; evaluation: TrialEvaluation }
  | {
      ok: false;
      index: number;
      failure: { agentName: string; strategyId: string; message: string };
    };

/**
 * Execute a bounded strategy-search run without letting an LLM grade itself.
 *
 * Agents see discovery context only. Every valid hypothesis is compared on the
 * same validation/OOS slice. The best validation Sharpe selects one strategy,
 * and that strategy is then backtested again on a separate final holdout slice.
 * The research validator receives the final holdout result plus evidence built
 * from the append-only trial ledger.
 */
export async function runResearchSearch(params: {
  event: CandidateEvent;
  context: ResearchContext;
  agents: readonly ResearchAgent[];
  validationCandles: OHLCV[];
  finalHoldoutCandles: OHLCV[];
  ledger: ResearchLedger;
  quant: ResearchQuantClient;
  options: ResearchSearchOptions;
}): Promise<ResearchSearchResult> {
  const {
    event,
    context,
    agents,
    validationCandles,
    finalHoldoutCandles,
    ledger,
    quant,
    options,
  } = params;

  if (!options.runId.trim()) throw new Error("runId must be non-empty");
  if (validationCandles.length < 4) throw new Error("validationCandles must contain at least four bars");
  if (finalHoldoutCandles.length < 4) throw new Error("finalHoldoutCandles must contain at least four bars");
  if ((await ledger.list(options.runId)).length > 0) {
    throw new Error(`Research runId already exists in ledger: ${options.runId}`);
  }

  const annualization = positiveFinite(options.annualization, 365.25 * 24 * 4);
  const minimumSuccessfulTrials = Math.max(2, Math.floor(options.minimumSuccessfulTrials ?? 2));
  const coordinator = new MultiAgentResearchCoordinator(agents, options.coordinator);
  const coordination = await coordinator.investigate(event, context);
  const runCreatedAt = Date.now();

  const outcomes = await Promise.all(
    coordination.hypotheses.map(async (row, index): Promise<EvaluationOutcome> => {
      const strategy = row.hypothesis.strategy;
      try {
        const backtest = await quant.backtest(strategy, validationCandles);
        const psr = await quant.psr(backtest.equityCurve, annualization);
        const trialId = `${options.runId}:${String(index + 1).padStart(3, "0")}:${slug(row.agentName)}`;
        const provenance = row.hypothesis.provenance;
        const record = createTrialRecord({
          runId: options.runId,
          trialId,
          createdAt: runCreatedAt + index,
          candidate: event,
          strategyId: strategy.id,
          confidence: row.hypothesis.confidence,
          provenance: {
            provider: provenance?.provider ?? "local",
            model: provenance?.model ?? row.agentName,
            promptVersion: provenance?.promptVersion ?? "unknown",
            responseId: provenance?.responseId,
            agentName: row.agentName,
          },
          metrics: {
            sharpe: backtest.sharpe,
            netReturn: backtest.netReturn,
            maxDrawdown: backtest.maxDrawdown,
            profitFactor: backtest.profitFactor,
            expectancy: backtest.expectancy,
            pValue: psr.pValue,
            outOfSampleReturns: equityReturns(backtest.equityCurve),
          },
        });
        return {
          ok: true,
          index,
          evaluation: { trialId, agentName: row.agentName, record, backtest },
        };
      } catch (error) {
        return {
          ok: false,
          index,
          failure: {
            agentName: row.agentName,
            strategyId: strategy.id,
            message: errorMessage(error),
          },
        };
      }
    })
  );

  const successfulOutcomes = outcomes
    .filter((outcome): outcome is Extract<EvaluationOutcome, { ok: true }> => outcome.ok)
    .sort((a, b) => a.index - b.index);
  const evaluationFailures = outcomes
    .filter((outcome): outcome is Extract<EvaluationOutcome, { ok: false }> => !outcome.ok)
    .sort((a, b) => a.index - b.index)
    .map((outcome) => outcome.failure);

  if (successfulOutcomes.length < minimumSuccessfulTrials) {
    throw new Error(
      `Research run produced ${successfulOutcomes.length} successful trials; at least ${minimumSuccessfulTrials} are required`
    );
  }

  // Persist in stable coordination order so JSONL evidence is reproducible even
  // when local backtests/PSR calls finish in a different order.
  for (const outcome of successfulOutcomes) {
    await ledger.append(outcome.evaluation.record);
  }

  const evaluations = successfulOutcomes.map((outcome) => outcome.evaluation);
  const ranked = [...evaluations].sort(compareTrialEvaluations);
  const selected = ranked[0];
  const selectedStrategy = coordination.hypotheses.find(
    (row) => row.hypothesis.strategy.id === selected.record.strategyId
  )?.hypothesis.strategy;
  if (!selectedStrategy) throw new Error("Selected strategy could not be resolved from coordination result");
  if (selected.backtest.strategyId !== selectedStrategy.id) {
    throw new Error("Selected strategy provenance mismatch");
  }

  const validationBacktest = selected.backtest;
  const finalHoldoutBacktest = await quant.backtest(selectedStrategy, finalHoldoutCandles);

  const records = await ledger.list(options.runId);
  const evidence = buildResearchEvidence(records, selected.trialId, {
    annualization,
    purgedCv: {
      nObservations: validationCandles.length,
      nSplits: options.purgedCv?.nSplits ?? 5,
      purgeBars: options.purgedCv?.purgeBars ?? 1,
      embargoBars: options.purgedCv?.embargoBars ?? 1,
    },
  });
  const researchValidation = await quant.validateResearch(finalHoldoutBacktest, evidence);

  return {
    runId: options.runId,
    selectedTrialId: selected.trialId,
    selectedStrategy,
    trialEvaluations: evaluations,
    agentFailures: coordination.failures,
    evaluationFailures,
    validationBacktest,
    finalHoldoutBacktest,
    evidence,
    researchValidation,
  };
}

export class HttpResearchQuantClient implements ResearchQuantClient {
  constructor(private readonly engineUrl = "http://localhost:8420") {}

  backtest(strategy: StrategyDefinition, candles: OHLCV[]): Promise<BacktestWithEquity> {
    return this.post<BacktestWithEquity>("/backtest", { strategy, candles });
  }

  psr(equityCurve: number[], annualization: number): Promise<PsrEvidence> {
    return this.post<PsrEvidence>("/stats/psr", {
      equityCurve,
      benchmarkSharpe: 0,
      annualization,
    });
  }

  validateResearch(
    result: BacktestWithEquity,
    evidence: ResearchValidationEvidence
  ): Promise<ValidationReport> {
    return this.post<ValidationReport>("/validate/research", { result, evidence });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.engineUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${path} failed (${response.status}): ${text}`);
    }
    return await response.json() as T;
  }
}

export function equityReturns(equityCurve: readonly number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i += 1) {
    const previous = equityCurve[i - 1];
    const current = equityCurve[i];
    if (!Number.isFinite(previous) || !Number.isFinite(current) || previous === 0) continue;
    const value = (current - previous) / previous;
    if (Number.isFinite(value)) returns.push(value);
  }
  return returns;
}

function compareTrialEvaluations(a: TrialEvaluation, b: TrialEvaluation): number {
  if (b.backtest.sharpe !== a.backtest.sharpe) return b.backtest.sharpe - a.backtest.sharpe;
  const ap = a.record.metrics.pValue ?? 1;
  const bp = b.record.metrics.pValue ?? 1;
  if (ap !== bp) return ap - bp;
  if (b.backtest.netReturn !== a.backtest.netReturn) return b.backtest.netReturn - a.backtest.netReturn;
  return a.trialId.localeCompare(b.trialId);
}

function positiveFinite(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
