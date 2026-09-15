import type {
  MarketSnapshot,
  CandidateEvent,
  BacktestResult,
  ValidationReport,
} from "@quant-swarm/shared";

// ─── Event Map ────────────────────────────────────────────────────────────────

export interface EventMap {
  "market.snapshot": MarketSnapshot;
  "scanner.candidate": CandidateEvent;
  "research.hypothesis": { strategyJson: unknown; confidence: number };
  "backtest.result": BacktestResult;
  "validation.result": ValidationReport;
  "risk.decision": { approved: boolean; reason?: string; mode: string };
  "pipeline.log": { stage: string; message: string; data?: unknown };
}

export type EventName = keyof EventMap;
type Handler<T> = (payload: T) => void | Promise<void>;

// ─── EventBus ─────────────────────────────────────────────────────────────────

/**
 * Simple typed in-process event bus.
 * Phase 2+ will swap this for NATS/Kafka without changing consumer code.
 */
export class EventBus {
  private handlers = new Map<string, Set<Handler<any>>>();

  on<K extends EventName>(event: K, handler: Handler<EventMap[K]>): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);

    // Return unsubscribe function
    return () => {
      this.handlers.get(event)?.delete(handler);
    };
  }

  async emit<K extends EventName>(event: K, payload: EventMap[K]): Promise<void> {
    const handlers = this.handlers.get(event);
    if (!handlers) return;

    for (const handler of handlers) {
      await handler(payload);
    }
  }

  removeAll(): void {
    this.handlers.clear();
  }

  listenerCount(event: EventName): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}
