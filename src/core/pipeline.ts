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
      // A progress snapshot contains the complete HTML seen so far. Keep it
      // on a short-lived UI channel instead of putting every copy into the
      // telemetry worker/history (which would inflate signal counts and
      // memory as a page hydrates).
      const progress = events.filter((event) => event.name === "site-export-progress");
      if (progress.length) observatoryBus.emit("exportProgress", progress[progress.length - 1]);
      const dataCleared = events.find((event) => event.name === "execution-data-cleared");
      if (dataCleared) observatoryBus.emit("dataCleared", { removed: Number(dataCleared.payload.removed ?? 0) });
      const automation = events.filter((event) => event.name.startsWith("automation-"));
      for (const event of automation) {
        observatoryBus.emit("automation", {
          name: event.name,
          payload: event.payload,
          timestamp: event.timestamp,
          duration: event.duration,
          status: event.status,
        });
      }
      const telemetry = events.filter((event) =>
        event.name !== "site-export-progress" &&
        event.name !== "execution-data-cleared" &&
        !event.name.startsWith("automation-"),
      );
      if (!telemetry.length) return;
      this.queue.push(...telemetry);
      observatoryBus.emit("raw", telemetry);
      this.scheduleFlush();
    });
    await this.transport.connect();
    observatoryBus.emit("status", "live");
  }
  send(payload: string) { this.transport.send?.(payload); }

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
