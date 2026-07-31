"use client";

import { useMemo } from "react";
import {
  Background,
  BaseEdge,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  getBezierPath,
  type EdgeProps,
  type NodeProps,
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import "@xyflow/react/dist/style.css";
import { useGraphStore } from "@/src/stores";

function TelemetryNode({ data }: NodeProps) {
  const model = data as { label: string; kind: string; duration: number; status: string };
  return (
    <div className={`graph-node graph-node--${model.status}`}>
      <Handle type="target" position={Position.Left} />
      <span className="graph-node__kind">{model.kind}</span>
      <strong>{model.label}</strong>
      <span>{model.duration.toFixed(1)} ms</span>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function PulseEdge(props: EdgeProps) {
  const [path] = getBezierPath(props);
  return (
    <>
      <BaseEdge path={path} markerEnd={props.markerEnd} style={{ stroke: "#3b4350" }} />
      <circle r="2.5" fill="#9d8cff">
        <animateMotion dur="1.8s" repeatCount="indefinite" path={path} />
      </circle>
    </>
  );
}

export function ExecutionGraph() {
  const graphNodes = useGraphStore((state) => state.nodes);
  const graphEdges = useGraphStore((state) => state.edges);
  const layout = useGraphStore((state) => state.layout);

  const { nodes, edges } = useMemo(() => {
    const visible = graphNodes.slice(-120);
    const visibleIds = new Set(visible.map((node) => node.id));
    const engine = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
    engine.setGraph({ rankdir: layout === "tree" ? "TB" : "LR", ranksep: 64, nodesep: 26 });
    visible.forEach((node) => engine.setNode(node.id, { width: 168, height: 62 }));
    graphEdges
      .filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
      .forEach((edge) => engine.setEdge(edge.source, edge.target));
    dagre.layout(engine);
    return {
      nodes: visible.map((node) => {
        const position = engine.node(node.id) ?? { x: 0, y: 0 };
        return {
          id: node.id,
          type: "telemetry",
          position: { x: position.x, y: position.y },
          data: { ...node },
        };
      }),
      edges: graphEdges
        .filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
        .map((edge) => ({
          ...edge,
          type: "pulse",
          markerEnd: { type: MarkerType.ArrowClosed, color: "#3b4350" },
        })),
    };
  }, [graphEdges, graphNodes, layout]);

  return (
    <div className="h-[520px] overflow-hidden rounded-xl border border-white/[.07] bg-[#0b0d10]">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={{ telemetry: TelemetryNode }}
        edgeTypes={{ pulse: PulseEdge }}
        minZoom={0.08}
        maxZoom={2}
        fitView
        onlyRenderVisibleElements
      >
        <Background color="#252b34" gap={24} size={1} />
        <MiniMap
          pannable
          zoomable
          maskColor="rgba(8,10,12,.78)"
          nodeColor="#7669e7"
          className="!border !border-white/10 !bg-[#11141a]"
        />
        <Controls className="observatory-controls" />
      </ReactFlow>
    </div>
  );
}
