"use client";

import { memo, useEffect, useMemo, useState } from "react";
import {
  Background, BaseEdge, Controls, EdgeLabelRenderer, Handle, MarkerType, MiniMap, NodeToolbar, Position, ReactFlow,
  getBezierPath, type Edge, type EdgeProps, type Node, type NodeProps, type ReactFlowInstance,
} from "@xyflow/react";

import "@xyflow/react/dist/style.css";
import { useGraphStore, useSelectionStore, useTelemetryStore } from "@/src/stores";

export type ExecutionGraphMode = "causal" | "session" | "subsystems" | "neighborhood" | "timeline";

type FlowData = { label: string; kind: string; duration: number; status: string; count?: number; aggregate?: boolean; stage?: string; process?: string; thread?: string; session?: string; sequence?: number; facts?: Array<[string,string]>; expandable?: boolean; expanded?: boolean; timelineStart?: number; laneLabel?: boolean };

const JOURNEY_HUE: Record<string, string> = {
  internet: "#3b8bd6",
  browser:  "#42c997",
  system:   "#a37bd3",
  runtime:  "#d4a957",
};

const KIND_INITIALS: Record<string, string> = {
  network: "Net", javascript: "JS", dom: "DOM", render: "Rdr",
  navigation: "Nav", memory: "Mem", scheduler: "Sch", css: "CSS",
};

const TelemetryNode = memo(function TelemetryNode({ data, selected }: NodeProps) {
  const model = data as FlowData;
  const journey = model.journey ?? "runtime";
  const rail = JOURNEY_HUE[journey] ?? "#42c997";
  const isError = model.status === "error";
  const isWarn  = model.status === "warning";
  const statusColor = isError ? "#ef6f78" : isWarn ? "#d4a957" : rail;
  const badge = model.aggregate
    ? String(model.count)
    : (KIND_INITIALS[model.kind] ?? model.kind.slice(0, 3).toUpperCase());

  if (model.aggregate) {
    return <>
      <NodeToolbar isVisible={selected} position={Position.Top}>
        <div className="gn-tooltip">
          <strong>{model.label}</strong>
          <span>{model.count} correlated events · {model.duration.toFixed(1)} ms total</span>
        </div>
      </NodeToolbar>
      <div className={`gn-agg${selected ? " gn-agg--selected" : ""}${isError ? " gn-agg--error" : isWarn ? " gn-agg--warn" : ""}`}
        style={{ "--rail": rail } as React.CSSProperties}>
        <Handle type="target" position={Position.Left} className="gn-handle" />
        <span className="gn-agg__badge" style={{ background: rail }}>{badge}</span>
        <div className="gn-agg__body">
          <strong>{model.label}</strong>
          <small>{model.count} events · {model.stage}</small>
        </div>
        <div className="gn-agg__stats">
          <span style={{ color: "#ef6f78" }}>{model.process}</span>
          <span style={{ color: "#d4a957" }}>{model.thread}</span>
        </div>
        <Handle type="source" position={Position.Right} className="gn-handle" />
      </div>
    </>;
  }

  return <>
    <NodeToolbar isVisible={selected} position={Position.Top}>
      <div className="gn-tooltip">
        <strong>{model.label}</strong>
        <span>{journey} · {model.kind} · {model.duration.toFixed(3)} ms · #{model.sequence}</span>
        {model.stage && model.stage !== "Stage unavailable" && <span>{model.stage}</span>}
        {model.process && model.process !== "Process unavailable" && <span>{model.process}</span>}
      </div>
    </NodeToolbar>
    <div
      className={`gn${selected ? " gn--selected" : ""}${isError ? " gn--error" : isWarn ? " gn--warn" : ""}${model.expandable ? " gn--expandable" : ""}`}
      style={{ "--rail": rail, "--status": statusColor } as React.CSSProperties}
      title={`${model.kind}: ${model.label} · ${model.duration.toFixed(1)} ms`}
    >
      <Handle type="target" position={Position.Left} className="gn-handle" />
      <span className="gn__rail" />
      <span className="gn__badge" style={{ background: `${rail}22`, color: rail, borderColor: `${rail}44` }}>{badge}</span>
      <div className="gn__body">
        <span className="gn__label">{model.label}</span>
        <div className="gn__meta">
          <i className={`gn__dot gn__dot--${model.status}`} />
          <span>{model.duration.toFixed(1)} ms</span>
          {model.expandable && <em className="gn__expand">{model.expanded ? "−" : "+"}</em>}
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="gn-handle" />
    </div>
  </>;
});

const OwnerLaneNode = memo(function OwnerLaneNode({ data }: NodeProps) {
  const model = data as FlowData;
  return <div className="owner-lane-node"><span>{model.label}</span></div>;
});

const graphNodeTypes = { telemetry: TelemetryNode, "lane-label": OwnerLaneNode };

function CausalEdge(props: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath(props);
  const relation = String(props.data?.relation ?? "parent");
  return <><BaseEdge path={path} markerEnd={props.markerEnd} className={`graph-edge graph-edge--${relation}`} style={props.style}/><EdgeLabelRenderer><span className={`graph-edge-label graph-edge-label--${relation}`} style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)` }}>{relation}</span></EdgeLabelRenderer></>;
}

const graphEdgeTypes = { causal: CausalEdge };

export function ExecutionGraph({ mode, nodeIds, selectedId }: { mode: ExecutionGraphMode; nodeIds: Set<string>; selectedId?: string }) {
  const graphNodes = useGraphStore((state) => state.nodes);
  const graphEdges = useGraphStore((state) => state.edges);
  const events = useTelemetryStore((state) => state.events);
  const select = useSelectionStore((state) => state.select);
  const [flow, setFlow] = useState<{ nodes: Node[]; edges: Edge[] }>({ nodes: [], edges: [] });
  const [instance, setInstance] = useState<ReactFlowInstance | null>(null);

  const model = useMemo(() => {
    const eventById = new Map(events.map((e) => [e.id, e]));
    const visible = graphNodes.filter((node) => nodeIds.has(node.id)).slice(-300);
    const visibleIds = new Set(visible.map((n) => n.id));
    const linked = graphEdges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target));
    if (mode === "subsystems") return aggregateSubsystems(visible, linked, eventById);
    const scoped = mode === "neighborhood" && selectedId ? neighborhood(visible, linked, selectedId, 2) : { nodes: visible, edges: linked };
    const compact = collapseNetworkRequests(scoped.nodes, scoped.edges, eventById);
    const timelineMode = mode === "timeline";
    return {
      nodes: compact.nodes.map((node) => {
        const event = eventById.get(node.id);
        const payload = event?.payload ?? {};
        return {
          id: node.id, type: "telemetry", position: { x: 0, y: 0 }, selected: node.id === selectedId,
          data: { ...node, journey: event ? eventJourney(event) : "runtime", stage: String(payload.browserStage ?? payload.systemStage ?? payload.journeyStage ?? "Stage unavailable"), process: String(payload.processName ?? payload.processId ?? "Process unavailable"), thread: String(payload.threadName ?? payload.thread ?? payload.threadId ?? "Thread unavailable"), session: event?.sessionId ?? "Unavailable", sequence: event?.sequence ?? 0, facts: payloadFacts(payload) },
        };
      }),
      edges: timelineMode ? [] : compact.edges.map((edge) => {
        const relation = edge.relation === "sequence" ? "next" : edgeRelation(eventById.get(edge.target));
        return { ...edge, type: "causal", label: relation, data: { relation }, markerEnd: { type: MarkerType.ArrowClosed } };
      }),
    };
  }, [events, graphEdges, graphNodes, mode, nodeIds, selectedId]);

  useEffect(() => {
    let cancelled = false;
    const eventById = new Map(events.map((e) => [e.id, e]));
    void Promise.resolve(ownerTimelineLayout(model.nodes, model.edges, eventById)).then((next) => { if (!cancelled) setFlow(next); });
    return () => { cancelled = true; };
  }, [events, model]);

  useEffect(() => {
    if (!instance || !flow.nodes.length) return;
    // A zero-duration fit avoids the resize/animation feedback loop that can
    // make Chromium report "ResizeObserver loop completed" while ReactFlow is
    // measuring freshly mounted nodes.
    const frame = window.requestAnimationFrame(() => void instance.fitView({ padding: .18, duration: 0 }));
    return () => window.cancelAnimationFrame(frame);
  }, [flow.nodes.length, instance]);

  return <div className="graph-canvas"><ReactFlow
    nodes={flow.nodes} edges={flow.edges}
    nodeTypes={graphNodeTypes} edgeTypes={graphEdgeTypes}
    onInit={setInstance}
    onNodeClick={(_, node) => { if (!String(node.id).startsWith("subsystem:")) select(node.id); }}
    minZoom={.04} maxZoom={3}
    nodesDraggable={false} onlyRenderVisibleElements
  >
    <Background color="#0e1820" gap={20} size={1} style={{ background: "#060c13" }} />
    <MiniMap pannable zoomable maskColor="rgba(6,12,19,.82)"
      nodeColor={(node) => { const j = String(node.data?.journey ?? "runtime"); return node.data?.status === "error" ? "#ef6f78" : node.data?.status === "warning" ? "#d4a957" : (({ internet: "#3b8bd6", browser: "#42c997", system: "#a37bd3", runtime: "#d4a957" } as Record<string,string>)[j] ?? "#42c997"); }}
      style={{ background: "#060c13", border: "1px solid #1e2b35" }}
    />
    <Controls className="observatory-controls" />
  </ReactFlow></div>;
}

/* ─── Timeline-by-owner layout ────────────────────────────────────────────── */

const LANE_H    = 64;   // total height per lane (px)
const NODE_H    = 40;   // node box height (px)
const NODE_W    = 172;  // base node width (px)
const LABEL_W   = 110;  // left gutter for lane labels
const MIN_GAP   = 6;    // min horizontal gap between nodes in same lane

type SwimlaneEventById = Map<string, ReturnType<typeof useTelemetryStore.getState>["events"][number]>;

function ownerTimelineKey(node: Node, eventById: SwimlaneEventById): string {
  const event = eventById.get(node.id);
  const p = event?.payload;
  if (event?.kind === "network") return `Network · connection ${String(p?.connectionId ?? "unknown")}`;
  const process = String(p?.processName ?? p?.process ?? "Browser runtime");
  const thread = String(p?.threadName ?? p?.thread ?? p?.threadId ?? "main");
  return `${process} · ${thread}`;
}

type GraphSourceNode = { id: string; label: string; kind: string; duration: number; status: string; count?: number; aggregate?: boolean; stage?: string; timelineStart?: number };
type GraphSourceEdge = { id: string; source: string; target: string; relation?: string };

function collapseNetworkRequests(nodes: GraphSourceNode[], edges: GraphSourceEdge[], eventById: SwimlaneEventById) {
  const members = new Map<string, GraphSourceNode[]>();
  for (const node of nodes) {
    const event = eventById.get(node.id);
    const requestId = event?.payload.requestId;
    if (event?.kind !== "network" || (typeof requestId !== "number" && typeof requestId !== "string")) continue;
    const key = `${event.sessionId}:${String(requestId)}`;
    members.set(key, [...(members.get(key) ?? []), node]);
  }

  const representative = new Map<string, string>();
  const collapsed = new Map<string, GraphSourceNode>();
  for (const group of members.values()) {
    const ordered = [...group].sort((left, right) => (eventById.get(left.id)?.sequence ?? 0) - (eventById.get(right.id)?.sequence ?? 0));
    const terminal = ordered.find((node) => String(eventById.get(node.id)?.payload.journeyStage) === "received") ?? ordered.at(-1)!;
    const event = eventById.get(terminal.id)!;
    const payload = event.payload;
    const measuredDuration = ordered.reduce((sum, node) => {
      const member = eventById.get(node.id);
      const measurement = String(member?.payload.measurement ?? "").toLowerCase();
      return ["unavailable", "not-timed", "boundary"].includes(measurement) ? sum : sum + Math.max(0, member?.duration ?? 0);
    }, 0);
    const url = typeof payload.url === "string" ? requestLabel(payload.url) : "HTTP request";
    const method = typeof payload.method === "string" ? payload.method : "HTTP";
    const status = ordered.some((node) => node.status === "error") ? "error" : ordered.some((node) => node.status === "warning") ? "warning" : "ok";
    collapsed.set(terminal.id, { ...terminal, label: `${method} ${url}`, duration: measuredDuration, timelineStart: eventById.get(ordered[0].id)?.timestamp ?? event.timestamp, status, count: ordered.length, aggregate: true, stage: `${ordered.length} network stages` } as GraphSourceNode);
    for (const node of ordered) representative.set(node.id, terminal.id);
  }

  const visible = nodes.filter((node) => !representative.has(node.id) || representative.get(node.id) === node.id).map((node) => collapsed.get(node.id) ?? node);
  const deduped = new Map<string, GraphSourceEdge>();
  for (const edge of edges) {
    const source = representative.get(edge.source) ?? edge.source;
    const target = representative.get(edge.target) ?? edge.target;
    if (source === target) continue;
    const key = `${source}:${target}:${edge.relation ?? "parent"}`;
    deduped.set(key, { ...edge, id: `collapsed:${key}`, source, target });
  }
  return { nodes: visible, edges: [...deduped.values()] };
}

function requestLabel(value: string) {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return value;
  }
}

function ownerTimelineLayout(nodes: Node[], causalEdges: Edge[], eventById: SwimlaneEventById): { nodes: Node[]; edges: Edge[] } {
  if (!nodes.length) return { nodes, edges: causalEdges };

  // 1. Determine lanes (ordered by first appearance)
  const laneOrder: string[] = [];
  const laneSet = new Set<string>();
  for (const node of nodes) {
    const key = ownerTimelineKey(node, eventById);
    if (!laneSet.has(key)) { laneSet.add(key); laneOrder.push(key); }
  }

  // 2. Resolve timestamps
  const getTs = (node: Node) => {
    const timelineStart = (node.data as FlowData | undefined)?.timelineStart;
    return typeof timelineStart === "number" ? timelineStart : eventById.get(node.id)?.timestamp ?? 0;
  };
  const timestamps = nodes.map(getTs).filter((t) => t > 0);
  const tMin = timestamps.length ? Math.min(...timestamps) : 0;
  const tMax = timestamps.length ? Math.max(...timestamps) : 1;
  const tRange = Math.max(1, tMax - tMin);

  // 3. Scale: fit into a canvas that's at least 1600px wide
  const CANVAS_W = Math.max(1600, nodes.length * (NODE_W * 0.4));
  const scale = (CANVAS_W - LABEL_W - NODE_W) / tRange;

  // 4. Build per-lane sorted node lists to detect collisions
  const laneNodes = new Map<string, Array<{ node: Node; t: number }>>();
  for (const node of nodes) {
    const key = ownerTimelineKey(node, eventById);
    const t = getTs(node) - tMin;
    const arr = laneNodes.get(key) ?? [];
    arr.push({ node, t });
    laneNodes.set(key, arr);
  }
  for (const arr of laneNodes.values()) arr.sort((a, b) => a.t - b.t);

  // 5. Resolve X positions (push right if overlapping in same lane)
  const resolvedX = new Map<string, number>();
  for (const arr of laneNodes.values()) {
    let prevRight = -Infinity;
    for (const { node, t } of arr) {
      const rawX = LABEL_W + t * scale;
      const x = Math.max(rawX, prevRight + MIN_GAP);
      resolvedX.set(node.id, x);
      prevRight = x + NODE_W;
    }
  }

  // 6. Position nodes
  const laneIndex = new Map(laneOrder.map((k, i) => [k, i]));
  const positionedNodes: Node[] = nodes.map((node) => {
    const key = ownerTimelineKey(node, eventById);
    const lane = laneIndex.get(key) ?? 0;
    const x = resolvedX.get(node.id) ?? LABEL_W;
    const y = lane * LANE_H + (LANE_H - NODE_H) / 2;
    return { ...node, position: { x, y } };
  });

  const laneLabels: Node[] = laneOrder.map((label, index) => ({
    id: `owner-lane:${index}:${label}`,
    type: "lane-label",
    position: { x: 0, y: index * LANE_H + 1 },
    selectable: false,
    draggable: false,
    data: { label, laneLabel: true, kind: "lane", duration: 0, status: "ok" },
  }));
  return { nodes: [...laneLabels, ...positionedNodes], edges: causalEdges };
}


function neighborhood<T extends { id: string }>(nodes: T[], edges: Array<{ id: string; source: string; target: string; relation?: string }>, center: string, depth: number) {
  const ids = new Set([center]); let frontier = new Set([center]);
  for (let level=0; level<depth; level+=1) { const next = new Set<string>(); for (const edge of edges) if (frontier.has(edge.source) || frontier.has(edge.target)) { next.add(edge.source); next.add(edge.target); } next.forEach((id) => ids.add(id)); frontier = next; }
  return { nodes: nodes.filter((node) => ids.has(node.id)), edges: edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)) };
}



function aggregateSubsystems(nodes: Array<{ id: string; label: string; kind: string; duration: number; status: string }>, edges: Array<{ id: string; source: string; target: string }>, eventById: Map<string, ReturnType<typeof useTelemetryStore.getState>["events"][number]>) {
  const key = (id: string, fallback: string) => { const event = eventById.get(id); return String(event?.payload.processName ?? event?.payload.systemStage ?? event?.payload.browserStage ?? fallback); };
  const groups = Map.groupBy(nodes, (node) => key(node.id, node.kind));
  const nodeGroup = new Map(nodes.map((node) => [node.id, key(node.id, node.kind)]));
  const aggregateNodes: Node[] = [...groups].map(([group, members]) => ({ id: `subsystem:${group}`, type: "telemetry", position: { x: 0, y: 0 }, data: { label: group, kind: "subsystem", duration: members.reduce((sum, item) => sum+item.duration,0), status: members.some((item) => item.status === "error") ? "error" : members.some((item) => item.status === "warning") ? "warning" : "ok", count: members.length, aggregate: true, stage: `${members.length} events`, process: `${members.filter((item) => item.status === "error").length} errors`, thread: `${members.filter((item) => item.status === "warning").length} warnings` } }));
  const pairs = new Map<string, { source: string; target: string; count: number }>();
  edges.forEach((edge) => { const source = nodeGroup.get(edge.source); const target = nodeGroup.get(edge.target); if (!source || !target || source === target) return; const id = `${source}->${target}`; const pair = pairs.get(id) ?? { source, target, count: 0 }; pair.count += 1; pairs.set(id, pair); });
  const aggregateEdges: Edge[] = [...pairs].map(([id, pair]) => ({ id: `aggregate:${id}`, source: `subsystem:${pair.source}`, target: `subsystem:${pair.target}`, type: "causal", label: `${pair.count} links`, data: { relation: "parent" }, markerEnd: { type: MarkerType.ArrowClosed } }));
  return { nodes: aggregateNodes, edges: aggregateEdges };
}

function edgeRelation(event?: ReturnType<typeof useTelemetryStore.getState>["events"][number]) { if (!event) return "parent"; if (event.payload.initiatorId) return "initiates"; if (event.payload.parentTaskId) return "schedules"; if (event.payload.parentCallId) return "calls"; if (event.status === "error") return "error"; return "parent"; }
function eventJourney(event: ReturnType<typeof useTelemetryStore.getState>["events"][number]) { if (typeof event.payload.systemStage === "string" || event.kind === "memory") return "system"; if (typeof event.payload.browserStage === "string" || ["dom","javascript","render"].includes(event.kind)) return "browser"; if (typeof event.payload.journeyStage === "string" || ["network","navigation"].includes(event.kind)) return "internet"; return "runtime"; }
function payloadFacts(payload: Record<string, unknown>) { return Object.entries(payload).filter(([,value]) => ["string","number","boolean"].includes(typeof value)).slice(0,6).map(([key,value]) => [key,String(value)] as [string,string]); }
