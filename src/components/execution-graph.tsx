"use client";

import { memo, useEffect, useMemo, useState } from "react";
import {
  Background, BaseEdge, Controls, EdgeLabelRenderer, Handle, MarkerType, MiniMap, NodeToolbar, Position, ReactFlow,
  getSmoothStepPath, type Edge, type EdgeProps, type Node, type NodeProps, type ReactFlowInstance,
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import "@xyflow/react/dist/style.css";
import { useGraphStore, useSelectionStore, useTelemetryStore } from "@/src/stores";

export type ExecutionGraphMode = "causal" | "session" | "subsystems" | "neighborhood";

type FlowData = { label: string; kind: string; duration: number; status: string; count?: number; aggregate?: boolean; journey?: string; stage?: string; process?: string; thread?: string; session?: string; sequence?: number; facts?: Array<[string,string]>; expandable?: boolean; expanded?: boolean };

const TelemetryNode = memo(function TelemetryNode({ data, selected }: NodeProps) {
  const model = data as FlowData;
  return <>
    <NodeToolbar isVisible={selected} position={Position.Top}><span className="graph-node-toolbar">{model.aggregate ? `${model.count} correlated events` : `${model.kind} · ${model.duration.toFixed(3)} ms`}</span></NodeToolbar>
    <article className={`graph-node graph-node--${model.status} ${model.aggregate ? "graph-node--aggregate" : ""} ${selected ? "graph-node--expanded" : ""}`} title={`${model.kind}: ${model.label} · ${model.duration.toFixed(1)} ms`}>
      <Handle type="target" position={Position.Left}/><header><i>{model.aggregate ? model.count : nodeInitial(model.label, model.kind)}</i><span><strong>{model.label}</strong><small>{model.aggregate ? "Correlated subsystem" : `${model.journey} · ${model.kind}`}</small></span><b>{model.duration.toFixed(2)} ms{model.expandable && <em>{model.expanded ? "−" : "+"}</em>}</b></header>
      <div className="graph-node__context"><span>{model.stage ?? "Stage unavailable"}</span><span>{model.process ?? "Process unavailable"}</span><span>{model.thread ?? "Thread unavailable"}</span></div>
      {selected && !model.aggregate && <div className="graph-node__facts">{model.facts?.map(([key,value]) => <span key={key}><small>{key}</small><code>{value}</code></span>)}<span><small>Session</small><code>{model.session}</code></span><span><small>Sequence</small><code>#{model.sequence}</code></span></div>}
      <Handle type="source" position={Position.Right}/>
    </article>
  </>;
});

function CausalEdge(props: EdgeProps) {
  const [path, labelX, labelY] = getSmoothStepPath(props);
  const relation = String(props.data?.relation ?? "parent");
  return <><BaseEdge path={path} markerEnd={props.markerEnd} className={`graph-edge graph-edge--${relation}`} style={props.style}/><EdgeLabelRenderer><span className={`graph-edge-label graph-edge-label--${relation}`} style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)` }}>{relation}</span></EdgeLabelRenderer></>;
}

export function ExecutionGraph({ mode, nodeIds, selectedId }: { mode: ExecutionGraphMode; nodeIds: Set<string>; selectedId?: string }) {
  const graphNodes = useGraphStore((state) => state.nodes);
  const graphEdges = useGraphStore((state) => state.edges);
  const events = useTelemetryStore((state) => state.events);
  const select = useSelectionStore((state) => state.select);
  const [flow, setFlow] = useState<{ nodes: Node[]; edges: Edge[] }>({ nodes: [], edges: [] });
  const [expandedIds, setExpandedIds] = useState<Set<string> | null>(null);
  const [instance, setInstance] = useState<ReactFlowInstance | null>(null);

  useEffect(() => {
    if (expandedIds || !graphNodes.length) return;
    const visibleIds = new Set(graphNodes.filter((node) => nodeIds.has(node.id)).map((node) => node.id));
    const linked = graphEdges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));
    const targets = new Set(linked.map((edge) => edge.target));
    setExpandedIds(new Set(graphNodes.filter((node) => visibleIds.has(node.id) && !targets.has(node.id)).map((node) => node.id)));
  }, [expandedIds, graphEdges, graphNodes, nodeIds]);

  const model = useMemo(() => {
    const eventById = new Map(events.map((event) => [event.id, event]));
    const visible = graphNodes.filter((node) => nodeIds.has(node.id)).slice(-300);
    const visibleIds = new Set(visible.map((node) => node.id));
    const linked = graphEdges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));
    if (mode === "subsystems") return aggregateSubsystems(visible, linked, eventById);
    const scoped = mode === "neighborhood" && selectedId ? neighborhood(visible, linked, selectedId, 2) : mode === "causal" || mode === "session" ? expandedGraph(visible, linked, expandedIds ?? new Set()) : { nodes: visible, edges: linked };
    const expandable = new Set(linked.map((edge) => edge.source));
    return {
      nodes: scoped.nodes.map((node) => { const event = eventById.get(node.id); const payload = event?.payload ?? {}; return { id: node.id, type: "telemetry", position: { x: 0, y: 0 }, selected: node.id === selectedId, data: { ...node, journey: event ? eventJourney(event) : "runtime", stage: String(payload.browserStage ?? payload.systemStage ?? payload.journeyStage ?? "Stage unavailable"), process: String(payload.processName ?? payload.processId ?? "Process unavailable"), thread: String(payload.threadName ?? payload.thread ?? payload.threadId ?? "Thread unavailable"), session: event?.sessionId ?? "Unavailable", sequence: event?.sequence ?? 0, facts: payloadFacts(payload), expandable: expandable.has(node.id), expanded: expandedIds?.has(node.id) ?? false } }; }),
      edges: scoped.edges.map((edge) => { const relation = edge.relation === "sequence" ? "next" : edgeRelation(eventById.get(edge.target)); return { ...edge, type: "causal", label: relation, data: { relation }, markerEnd: { type: MarkerType.ArrowClosed } }; }),
    };
  }, [events, expandedIds, graphEdges, graphNodes, mode, nodeIds, selectedId]);

  useEffect(() => {
    let cancelled = false;
    const direction = mode === "session" ? "TB" : "LR";
    const run = Promise.resolve(dagreLayout(model.nodes, model.edges, direction));
    void run.then((next) => { if (!cancelled) setFlow(next); });
    return () => { cancelled = true; };
  }, [mode, model]);

  useEffect(() => { if (!instance || !flow.nodes.length) return; const frame = window.requestAnimationFrame(() => void instance.fitView({ padding: .18, duration: 280 })); return () => window.cancelAnimationFrame(frame); }, [flow.nodes.length, instance]);

  return <div className="graph-canvas"><ReactFlow nodes={flow.nodes} edges={flow.edges} nodeTypes={{ telemetry: TelemetryNode }} edgeTypes={{ causal: CausalEdge }} onInit={setInstance} onNodeClick={(_, node) => { if (String(node.id).startsWith("subsystem:")) return; select(node.id); if ((mode === "causal" || mode === "session") && node.data.expandable) setExpandedIds((current) => { const next = new Set(current ?? []); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next; }); }} minZoom={.08} maxZoom={2} fitView fitViewOptions={{ padding: .18 }} nodesDraggable={false} onlyRenderVisibleElements>
    <Background color="#252b34" gap={24} size={1}/><MiniMap pannable zoomable maskColor="rgba(8,10,12,.78)" nodeColor={(node) => node.data?.status === "error" ? "#dd7777" : "#42c997"}/><Controls className="observatory-controls"/>
  </ReactFlow></div>;
}

function dagreLayout(nodes: Node[], edges: Edge[], rankdir: "LR" | "TB") {
  const engine = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  engine.setGraph({ rankdir, ranksep: 105, nodesep: 58 });
  nodes.forEach((node) => engine.setNode(node.id, { width: node.data.aggregate ? 230 : 280, height: node.selected ? 238 : 112 }));
  edges.forEach((edge) => engine.setEdge(edge.source, edge.target));
  dagre.layout(engine);
  return { nodes: nodes.map((node) => { const point = engine.node(node.id) ?? { x: 0, y: 0 }; const width = node.data.aggregate ? 230 : 280; const height = node.selected ? 238 : 112; return { ...node, position: { x: point.x-width/2, y: point.y-height/2 } }; }), edges };
}

function neighborhood<T extends { id: string }>(nodes: T[], edges: Array<{ id: string; source: string; target: string; relation?: string }>, center: string, depth: number) {
  const ids = new Set([center]); let frontier = new Set([center]);
  for (let level=0; level<depth; level+=1) { const next = new Set<string>(); for (const edge of edges) if (frontier.has(edge.source) || frontier.has(edge.target)) { next.add(edge.source); next.add(edge.target); } next.forEach((id) => ids.add(id)); frontier = next; }
  return { nodes: nodes.filter((node) => ids.has(node.id)), edges: edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)) };
}

function expandedGraph<T extends { id: string }>(nodes: T[], edges: Array<{ id: string; source: string; target: string; relation?: string }>, expanded: Set<string>) {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const targets = new Set(edges.map((edge) => edge.target));
  const roots = nodes.filter((node) => !targets.has(node.id)).map((node) => node.id);
  const visible = new Set(roots.length ? roots : nodes.slice(0,1).map((node) => node.id));
  const queue = [...visible];
  while (queue.length) { const id = queue.shift()!; if (!expanded.has(id)) continue; for (const edge of edges) if (edge.source === id && nodeIds.has(edge.target) && !visible.has(edge.target)) { visible.add(edge.target); queue.push(edge.target); } }
  return { nodes: nodes.filter((node) => visible.has(node.id)), edges: edges.filter((edge) => visible.has(edge.source) && visible.has(edge.target)) };
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
function nodeInitial(label: string, kind: string) { const words = label.split(/[\s:._/-]+/).filter(Boolean); return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : label.slice(0,2) || kind.slice(0,2)).toUpperCase(); }
