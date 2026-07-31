export type TelemetryKind =
  | "navigation"
  | "network"
  | "dom"
  | "javascript"
  | "scheduler"
  | "render"
  | "memory"
  | "log";

export interface TelemetryEvent {
  id: string;
  sessionId: string;
  sequence: number;
  timestamp: number;
  duration: number;
  kind: TelemetryKind;
  name: string;
  status: "ok" | "warning" | "error";
  parentId?: string;
  payload: Record<string, unknown>;
}

export interface GraphNodeModel {
  id: string;
  label: string;
  kind: TelemetryKind;
  duration: number;
  status: TelemetryEvent["status"];
}

export interface GraphEdgeModel {
  id: string;
  source: string;
  target: string;
}

export interface WorkerSnapshot {
  events: TelemetryEvent[];
  graphNodes: GraphNodeModel[];
  graphEdges: GraphEdgeModel[];
  rates: Array<[number, number]>;
  p95: number;
}
