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
      this.socket.onopen = () => {
        this.state = "open";
        resolve();
      };
      this.socket.onerror = () => reject(new Error("Telemetry transport failed"));
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
      sessionId: "velora-local-01",
      sequence,
      timestamp: Date.now(),
      duration,
      kind,
      name: eventName(kind, sequence),
      status: duration > 130 ? "error" : duration > 75 ? "warning" : "ok",
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
