import { Activity, Braces, Cpu, Database, FileDown, GitBranch, Globe2, MonitorCog, Network, Play, TerminalSquare, TimerReset } from "lucide-react";
import type { ObservatoryPlugin } from "@/src/plugins/types";
import { GraphPanel, NetworkPanel, OverviewPanel, TimelinePanel } from "@/src/components/panels";
import { ExecutionPanel } from "@/src/components/execution-panel";
import { ConsolePanel, InspectorPanel } from "@/src/components/tooling-panels";
import { InternetJourneyPanel } from "@/src/journeys/internet/internet-journey-panel";
import { BrowserJourneyPanel } from "@/src/journeys/browser/browser-journey-panel";
import { SystemJourneyPanel } from "@/src/journeys/system/system-journey-panel";
import { ApplicationPanel } from "@/src/components/application-panel";
import { ExportPanel } from "@/src/components/export-panel";

export const plugins: ObservatoryPlugin[] = [
  { id: "overview", route: "/", label: "Overview", description: "Runtime health and metrics", icon: Activity, component: OverviewPanel },
  { id: "internet-journey", route: "/internet-journey", label: "Internet Journey", description: "URL to HTTP response", icon: Globe2, component: InternetJourneyPanel, badge: "New" },
  { id: "browser-journey", route: "/browser-journey", label: "Browser Journey", description: "Response to presented frame", icon: Cpu, component: BrowserJourneyPanel, badge: "New" },
  { id: "system-journey", route: "/system-journey", label: "System Journey", description: "OS and hardware execution", icon: MonitorCog, component: SystemJourneyPanel, badge: "New" },
  { id: "timeline", route: "/timeline", label: "Global Timeline", description: "All normalized telemetry events", icon: TimerReset, component: TimelinePanel },
  { id: "graph", route: "/graph", label: "Execution graph", description: "Causal graph explorer", icon: GitBranch, component: GraphPanel, badge: "120" },
  { id: "network", route: "/network", label: "Network", description: "Requests and responses", icon: Network, component: NetworkPanel },
  { id: "replay", route: "/replay", label: "Execution", description: "Controlled execution artifacts", icon: Play, component: ExecutionPanel },
  { id: "inspector", route: "/inspector", label: "Event inspector", description: "Structured payload editor", icon: Braces, component: InspectorPanel },
  { id: "console", route: "/console", label: "Console", description: "Runtime diagnostics", icon: TerminalSquare, component: ConsolePanel },
  { id: "application", route: "/application", label: "Application", description: "Cookies and origin storage", icon: Database, component: ApplicationPanel, sidebar: false },
  { id: "export", route: "/export", label: "Export", description: "Download telemetry as JSON, Markdown, or HTML", icon: FileDown, component: ExportPanel, sidebar: false },
];

export function getPlugin(id: string) {
  return plugins.find((plugin) => plugin.id === id) ?? plugins[0];
}
