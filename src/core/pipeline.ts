import { observatoryBus } from "@/src/core/event-bus";
import type { TelemetryEvent, WorkerSnapshot } from "@/src/core/types";
import type { Transport } from "@/src/core/transport";

export class TelemetryPipeline {
  private worker?: Worker;
  private unsubscribe?: () => void;
  private queue: TelemetryEvent[] = [];
  private frame?: number;

  constructor(private readonly transport: Transport) {}

  async start() {
    observatoryBus.emit("status", "connecting");
    this.worker = new Worker(new URL("../workers/telemetry.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = ({ data }: MessageEvent<WorkerSnapshot>) => {
      observatoryBus.emit("snapshot", data);
    };
    this.unsubscribe = this.transport.subscribe((payload) => {
      const events = this.parse(payload);
      this.queue.push(...events);
      observatoryBus.emit("raw", events);
      this.scheduleFlush();
    });
    await this.transport.connect();
    observatoryBus.emit("status", "live");
  }

  stop() {
    this.unsubscribe?.();
    this.transport.close();
    this.worker?.terminate();
    if (this.frame) cancelAnimationFrame(this.frame);
    observatoryBus.emit("status", "offline");
  }

  private parse(payload: string | ArrayBuffer): TelemetryEvent[] {
    if (typeof payload !== "string") {
      throw new Error("Binary telemetry parser is not enabled yet");
    }
    const decoded: unknown = JSON.parse(payload);
    return Array.isArray(decoded) ? (decoded as TelemetryEvent[]) : [decoded as TelemetryEvent];
  }

  private scheduleFlush() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      const batch = this.queue.splice(0, 2_000);
      this.worker?.postMessage({ type: "append", batch });
      this.frame = undefined;
      if (this.queue.length) this.scheduleFlush();
    });
  }
}
