export type BrowserStageType = "boundary" | "decode" | "cache" | "parser" | "resource" | "javascript" | "scheduler" | "dom" | "render" | "gpu";

export interface BrowserJourneyNode {
  id: string;
  type: BrowserStageType;
  title: string;
  description: string;
  duration: number;
  timestamp: number;
  status: "pending" | "active" | "complete" | "unavailable" | "error";
  process: string;
  thread: string;
  metadata: Record<string, string | number>;
}
