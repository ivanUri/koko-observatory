import type { TelemetryEvent } from "@/src/core/types";

export interface Transport {
  readonly state: "idle" | "connecting" | "open" | "closed";
  connect(): Promise<void>;
  close(): void;
  send?(payload: string): void;
  subscribe(handler: (payload: string | ArrayBuffer) => void): () => void;
}

export class WebSocketTransport implements Transport {
  private socket?: WebSocket;
  private listeners = new Set<(payload: string | ArrayBuffer) => void>();
  state: Transport["state"] = "idle";

  constructor(private readonly url: string) {}

  async connect() {
    this.state = "connecting";
    await new Promise<void>((resolve, reject) => {
      this.socket = new WebSocket(this.url);
      this.socket.binaryType = "arraybuffer";
      const timeout = window.setTimeout(() => {
        this.socket?.close();
        this.state = "closed";
        reject(new Error(`Telemetry transport timeout: ${this.url}`));
      }, 5_000);
      this.socket.onopen = () => {
        window.clearTimeout(timeout);
        this.state = "open";
        resolve();
      };
      this.socket.onerror = () => {
        window.clearTimeout(timeout);
        this.state = "closed";
        reject(new Error("Telemetry transport failed"));
      };
      this.socket.onmessage = ({ data }) => {
        for (const listener of this.listeners) listener(data);
      };
      this.socket.onclose = () => {
        this.state = "closed";
      };
    });
  }

  close() {
    this.socket?.close();
    this.state = "closed";
  }
  send(payload: string) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(payload); }

  subscribe(handler: (payload: string | ArrayBuffer) => void) {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }
}

export class DemoTransport implements Transport {
  private listeners = new Set<(payload: string) => void>();
  private timer?: ReturnType<typeof setInterval>;
  private sequence = 0;
  state: Transport["state"] = "idle";

  async connect() {
    this.state = "open";
    this.timer = setInterval(() => {
      const batch = Array.from({ length: 18 }, () => this.makeEvent());
      const payload = JSON.stringify(batch);
      for (const listener of this.listeners) listener(payload);
    }, 280);
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.state = "closed";
  }

  send(payload: string) {
    try {
      const command = JSON.parse(payload) as { type?: string; url?: string };
      if (command.type !== "inspect-url" || !command.url) return;
      const requestedUrl = new URL(command.url).href;
      const inspectionId = `demo-inspection-${Date.now()}`;
      const base = {
        inspectionId,
        requestedUrl,
        source: "demo-transport",
      };
      this.emitLifecycle(inspectionId, requestedUrl, "started", base);
      window.setTimeout(() => {
        this.emitInspectionNetwork(inspectionId, requestedUrl, base);
        this.emitLifecycleStage(inspectionId, requestedUrl, "domcontentloaded", base);
        window.setTimeout(() => {
          this.emitLifecycleStage(inspectionId, requestedUrl, "load", base);
          window.setTimeout(() => {
            this.emitLifecycleStage(inspectionId, requestedUrl, "domstable", base);
            this.emitLifecycleStage(inspectionId, requestedUrl, "networkidle", base);
            this.emitLifecycle(inspectionId, requestedUrl, "completed", base);
          }, 70);
        }, 45);
      }, 80);
    } catch {
      // Ignore malformed demo commands; the real bridge validates commands.
    }
  }

  subscribe(handler: (payload: string) => void) {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  private makeEvent(): TelemetryEvent {
    const kinds: TelemetryEvent["kind"][] = [
      "network",
      "dom",
      "javascript",
      "scheduler",
      "render",
      "memory",
    ];
    const kind = kinds[this.sequence % kinds.length];
    const duration = Math.round((2 + Math.random() * (kind === "network" ? 180 : 42)) * 10) / 10;
    const sequence = ++this.sequence;
    return {
      id: `evt-${sequence}`,
      sessionId: "koko-local-01",
      sequence,
      timestamp: Date.now(),
      duration,
      kind,
      name: eventName(kind, sequence),
      status: kind === "network"
        ? (duration > 75 ? "warning" : "ok")
        : (duration > 130 ? "error" : duration > 75 ? "warning" : "ok"),
      parentId: sequence > 1 ? `evt-${Math.max(1, sequence - (sequence % 5 || 1))}` : undefined,
      payload: {
        demo: true,
        inspectionId: "demo-session",
        requestedUrl: "Demo telemetry",
        url: kind === "network" ? `/api/runtime/${sequence % 12}` : undefined,
        frameId: "frame-main",
        realmEpoch: Math.floor(sequence / 80) + 1,
      },
    };
  }

  private emitLifecycle(inspectionId: string, url: string, state: "started" | "completed", base: Record<string, string>) {
    const event: TelemetryEvent = {
      id: `${inspectionId}:${state}`,
      sessionId: inspectionId,
      sequence: ++this.sequence,
      timestamp: Date.now(),
      duration: 0,
      kind: "log",
      name: `inspection-${state}`,
      status: "ok",
      payload: { ...base, inspectionId, requestedUrl: url, inspectionState: state },
    };
    for (const listener of this.listeners) listener(JSON.stringify(event));
  }

  private emitLifecycleStage(inspectionId: string, url: string, stage: "domcontentloaded" | "load" | "domstable" | "networkidle", base: Record<string, string>) {
    const event: TelemetryEvent = {
      id: `${inspectionId}:lifecycle:${stage}`,
      sessionId: inspectionId,
      sequence: ++this.sequence,
      timestamp: Date.now(),
      duration: 0,
      kind: "navigation",
      name: stage,
      status: "ok",
      payload: { ...base, inspectionId, requestedUrl: url, lifecycleStage: stage, executionStatus: "recording", source: "demo-transport" },
    };
    for (const listener of this.listeners) listener(JSON.stringify(event));
  }

  private emitInspectionNetwork(inspectionId: string, url: string, base: Record<string, string>) {
    const stages: Array<[string, number, Record<string, unknown>]> = [
      ["queue", 1, { measurement: "measured" }],
      ["cache", 0, { measurement: "not-timed", cacheDecision: "not-observed" }],
      ["dns", 4, { measurement: "measured", primaryIp: "93.184.216.34" }],
      ["routing", 0, { measurement: "unavailable" }],
      ["proxy", 0, { measurement: "not-timed", usedProxy: false }],
      ["tcp", 18, { measurement: "measured", primaryIp: "93.184.216.34", httpVersion: "h1" }],
      ["tls", 41, { measurement: "measured", httpVersion: "h1" }],
      ["request", 2, { measurement: "measured", method: "GET", url }],
      ["redirect", 0, { measurement: "not-timed", redirectCount: 0 }],
      ["server", 25, { measurement: "measured", responseStatus: 200 }],
      ["response", 12, { measurement: "measured", responseStatus: 200, responseBodyBytes: 24800, contentType: "text/html", contentEncoding: "identity", httpVersion: "h1" }],
      ["received", 0, { measurement: "boundary", responseStatus: 200, responseBodyBytes: 24800 }],
    ];
    const events = stages.map(([journeyStage, duration, payload]) => ({
      id: `${inspectionId}:${journeyStage}`,
      sessionId: inspectionId,
      sequence: ++this.sequence,
      timestamp: Date.now(),
      duration,
      kind: "network" as const,
      name: journeyStage,
      status: "ok" as const,
      payload: { ...base, inspectionId, requestedUrl: url, journeyStage, url, ...payload },
    }));
    for (const listener of this.listeners) listener(JSON.stringify(events));
  }
}

function eventName(kind: TelemetryEvent["kind"], sequence: number) {
  const names: Record<TelemetryEvent["kind"], string[]> = {
    navigation: ["commit", "document-ready"],
    network: ["GET /api/products", "script chunk", "image decode"],
    dom: ["mutation batch", "style invalidation", "layout tree"],
    javascript: ["microtask checkpoint", "evaluate", "promise reaction"],
    scheduler: ["task dispatch", "timer fired", "idle callback"],
    render: ["layout", "paint", "composite"],
    memory: ["arena acquire", "heap sample", "gc cycle"],
    log: ["runtime log"],
  };
  const options = names[kind];
  return options[sequence % options.length];
}
