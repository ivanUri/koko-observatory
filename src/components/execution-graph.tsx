"use client";

import { useMemo } from "react";
import {
  Background,
  BaseEdge,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  getStraightPath,
  type EdgeProps,
  type NodeProps,
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import "@xyflow/react/dist/style.css";
import { useGraphStore, useSelectionStore } from "@/src/stores";

function TelemetryNode({ data }: NodeProps) {
  const model = data as { label: string; kind: string; duration: number; status: string };
  return (
    <div className={`graph-node graph-node--${model.status}`} title={`${model.kind}: ${model.label} · ${model.duration.toFixed(1)} ms`}>
      <Handle type="target" position={Position.Top} />
      <span>{nodeInitial(model.label, model.kind)}</span>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

function PulseEdge(props: EdgeProps) {
  const [path] = getStraightPath(props);
  return (
    <>
      <BaseEdge path={path} style={{ stroke: "#72808d", strokeWidth: 1.15 }} />
      <circle r="2" fill="#55d57d">
        <animateMotion dur="1.8s" repeatCount="indefinite" path={path} />
      </circle>
    </>
  );
}

export function ExecutionGraph() {
  const graphNodes = useGraphStore((state) => state.nodes);
  const graphEdges = useGraphStore((state) => state.edges);
  const layout = useGraphStore((state) => state.layout);
  const select = useSelectionStore((state) => state.select);

  const { nodes, edges } = useMemo(() => {
    const visible = graphNodes.slice(-160);
    const visibleIds = new Set(visible.map((node) => node.id));
    const engine = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
    engine.setGraph({ rankdir: "TB", ranksep: layout === "tree" ? 96 : 76, nodesep: 54 });
    visible.forEach((node) => engine.setNode(node.id, { width: 48, height: 48 }));
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
          position: { x: position.x - 24, y: position.y - 24 },
          data: { ...node },
        };
      }),
      edges: graphEdges
        .filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
        .map((edge) => ({
          ...edge,
          type: "pulse",
        })),
    };
  }, [graphEdges, graphNodes, layout]);

  return (
    <div className="graph-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={{ telemetry: TelemetryNode }}
        edgeTypes={{ pulse: PulseEdge }}
        onNodeClick={(_, node) => select(node.id)}
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
          nodeColor="#42c997"
          className="!border !border-white/10 !bg-[#11141a]"
        />
        <Controls className="observatory-controls" />
      </ReactFlow>
    </div>
  );
}

function nodeInitial(label: string, kind: string) {
  const words = label.split(/[\s:._/-]+/).filter(Boolean);
  const text = words.length > 1 ? `${words[0][0]}${words[1][0]}` : label.slice(0, 2) || kind.slice(0, 2);
  return text.toUpperCase();
}
