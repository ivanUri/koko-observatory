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
