import { describe, it, expect, vi } from "vitest";
import { EventBus } from "../src/index.js";

describe("EventBus", () => {
  it("delivers events to subscribers", async () => {
    const bus = new EventBus();
    const handler = vi.fn();

    bus.on("pipeline.log", handler);
    await bus.emit("pipeline.log", { stage: "test", message: "hello" });

    expect(handler).toHaveBeenCalledWith({ stage: "test", message: "hello" });
  });

  it("supports multiple subscribers", async () => {
    const bus = new EventBus();
    const h1 = vi.fn();
    const h2 = vi.fn();

    bus.on("pipeline.log", h1);
    bus.on("pipeline.log", h2);
    await bus.emit("pipeline.log", { stage: "test", message: "multi" });

    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it("unsubscribe works", async () => {
    const bus = new EventBus();
    const handler = vi.fn();

    const unsub = bus.on("pipeline.log", handler);
    unsub();
    await bus.emit("pipeline.log", { stage: "test", message: "none" });

    expect(handler).not.toHaveBeenCalled();
  });

  it("does not error on emit with no listeners", async () => {
    const bus = new EventBus();
    await expect(
      bus.emit("pipeline.log", { stage: "test", message: "noop" })
    ).resolves.toBeUndefined();
  });

  it("removeAll clears all handlers", async () => {
    const bus = new EventBus();
    bus.on("pipeline.log", vi.fn());
    bus.on("scanner.candidate", vi.fn() as any);

    bus.removeAll();

    expect(bus.listenerCount("pipeline.log")).toBe(0);
    expect(bus.listenerCount("scanner.candidate")).toBe(0);
  });
});
