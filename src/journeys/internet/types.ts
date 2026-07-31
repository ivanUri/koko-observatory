export type JourneyStatus = "complete" | "active" | "pending" | "skipped";

export interface JourneyDetail {
  label: string;
  value: string;
}

export interface JourneyNode {
  id: string;
  type: "url" | "dns" | "connection" | "tls" | "http" | "routing" | "server" | "response" | "boundary";
  timestamp: number;
  duration: number;
  parent?: string;
  title: string;
  description: string;
  status: JourneyStatus;
  metadata: {
    summary: JourneyDetail[];
    explanation: string;
    issues: string[];
    practices: string[];
    reference: string;
    raw?: string;
    estimated?: boolean;
  };
}

export interface JourneyEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}
