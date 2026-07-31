import { Activity, Braces, GitBranch, Network, Play, TerminalSquare, TimerReset } from "lucide-react";
import type { ObservatoryPlugin } from "@/src/plugins/types";
import { GraphPanel, NetworkPanel, OverviewPanel, ReplayPanel, TimelinePanel } from "@/src/components/panels";
import { ConsolePanel, InspectorPanel } from "@/src/components/tooling-panels";

export const plugins: ObservatoryPlugin[] = [
  { id: "overview", label: "Overview", description: "Runtime health and metrics", icon: Activity, component: OverviewPanel },
  { id: "timeline", label: "Timeline", description: "Indexed event timeline", icon: TimerReset, component: TimelinePanel },
  { id: "graph", label: "Execution graph", description: "Causal graph explorer", icon: GitBranch, component: GraphPanel, badge: "120" },
  { id: "network", label: "Network", description: "Requests and responses", icon: Network, component: NetworkPanel },
  { id: "replay", label: "Replay", description: "Deterministic sessions", icon: Play, component: ReplayPanel },
  { id: "inspector", label: "Event inspector", description: "Structured payload editor", icon: Braces, component: InspectorPanel },
  { id: "console", label: "Console", description: "Runtime diagnostics", icon: TerminalSquare, component: ConsolePanel },
];

export function getPlugin(id: string) {
  return plugins.find((plugin) => plugin.id === id) ?? plugins[0];
}
