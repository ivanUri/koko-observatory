import type { Edge, Node } from "@xyflow/react";
import type { BrowserJourneyNode } from "./types";

let elkPromise: Promise<InstanceType<typeof import("elkjs/lib/elk.bundled.js").default>> | undefined;

function getElk() {
  elkPromise ??= import("elkjs/lib/elk.bundled.js").then(({ default: ELK }) => new ELK());
  return elkPromise;
}

export const browserStages = [
  { id: "network", label: "01 · NETWORK", nodes: ["response", "decompression", "cache"] },
  { id: "parse", label: "02 · PARSE", nodes: ["html-parser", "preload", "dom", "css-parser"] },
  { id: "execute", label: "03 · EXECUTE", nodes: ["javascript", "event-loop", "mutations"] },
  { id: "render", label: "04 · RENDER", nodes: ["style", "layout", "paint", "layers", "raster"] },
  { id: "composite", label: "05 · COMPOSITE", nodes: ["composite", "frame"] },
] as const;

const stageByNode = new Map(browserStages.flatMap((stage) => stage.nodes.map((id) => [id, stage.id])));

export type BrowserFlowData = BrowserJourneyNode & {
  incomingHandles: string[];
  outgoingHandles: string[];
  stage: string;
  expanded: boolean;
  onToggle: (id: string) => void;
};

export async function layoutBrowserFlow(
  items: BrowserJourneyNode[],
  edges: Edge[],
  expandedIds: Set<string>,
  onToggle: (id: string) => void,
): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const elk = await getElk();
  const visibleIds = new Set(items.map((item) => item.id));
  const visibleEdges = edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();

  for (const edge of visibleEdges) {
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), `${edge.id}-target`]);
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), `${edge.id}-source`]);
  }

  const result = await elk.layout({
    id: "browser-journey",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.spacing.nodeNodeBetweenLayers": "115",
      "elk.spacing.nodeNode": "72",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    },
    children: items.map((item) => ({
      id: item.id,
      width: 300,
      height: expandedIds.has(item.id) ? Math.max(230, 205 + Object.keys(item.metadata).length * 28) : 84,
    })),
    edges: visibleEdges.map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
  });

  const positions = new Map(result.children?.map((node) => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]) ?? []);
  const flowNodes: Node[] = items.map((item) => ({
    id: item.id,
    type: "browser",
    position: positions.get(item.id) ?? { x: 0, y: 0 },
    data: {
      ...item,
      incomingHandles: incoming.get(item.id) ?? [],
      outgoingHandles: outgoing.get(item.id) ?? [],
      stage: stageByNode.get(item.id) ?? "render",
      expanded: expandedIds.has(item.id),
      onToggle,
    } satisfies BrowserFlowData,
    zIndex: 2,
  }));

  const itemById = new Map(flowNodes.map((node) => [node.id, node]));
  const groupNodes: Node[] = browserStages.flatMap((stage) => {
    const members = stage.nodes.map((id) => itemById.get(id)).filter((node): node is Node => Boolean(node));
    if (!members.length) return [];
    const left = Math.min(...members.map((node) => node.position.x)) - 24;
    const top = Math.min(...members.map((node) => node.position.y)) - 46;
    const right = Math.max(...members.map((node) => node.position.x + 300)) + 24;
    const bottom = Math.max(...members.map((node) => node.position.y + (expandedIds.has(node.id) ? Math.max(230, 205 + Object.keys(items.find((item) => item.id === node.id)?.metadata ?? {}).length * 28) : 84))) + 24;
    return [{
      id: `stage-${stage.id}`,
      type: "stageGroup",
      position: { x: left, y: top },
      data: { label: stage.label, stage: stage.id },
      style: { width: right - left, height: bottom - top },
      selectable: false,
      draggable: false,
      focusable: false,
      connectable: false,
      zIndex: 0,
    }];
  });

  return {
    nodes: [...groupNodes, ...flowNodes],
    edges: visibleEdges.map((edge) => ({
      ...edge,
      type: "smoothstep",
      sourceHandle: `${edge.id}-source`,
      targetHandle: `${edge.id}-target`,
      zIndex: 1,
    })),
  };
}
