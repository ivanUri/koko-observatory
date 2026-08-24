export type AutomationAction = "navigate" | "click" | "fill" | "select" | "check" | "press" | "hover" | "scroll" | "wait";
export type LocatorKind = "css" | "role" | "id" | "name" | "placeholder";
export type AutomationStepStatus = "idle" | "running" | "completed" | "failed";

export interface AutomationLocator {
  kind: LocatorKind;
  value: string;
  name?: string;
}

export interface AutomationStep {
  id: string;
  action: AutomationAction;
  locator?: AutomationLocator;
  value?: string;
  checked?: boolean;
  key?: string;
  x?: number;
  y?: number;
  timeoutMs?: number;
  status: AutomationStepStatus;
  error?: string;
  durationMs?: number;
  result?: string;
}

export interface AutomationWorkflow {
  id: string;
  name: string;
  startUrl: string;
  steps: AutomationStep[];
  createdAt: number;
  updatedAt: number;
  lastRunStatus?: "idle" | "running" | "completed" | "failed";
  lastError?: string;
  lastSessionUrl?: string;
}

export interface InteractiveElementModel {
  backendNodeId?: number;
  tagName: string;
  role?: string;
  name?: string;
  type?: string;
  disabled?: boolean;
  id?: string;
  class?: string;
  href?: string;
  inputType?: string;
  value?: string;
  elementName?: string;
  placeholder?: string;
}

export interface AutomationSession {
  status: "idle" | "starting" | "ready" | "running" | "stopped" | "error";
  id?: string;
  url?: string;
  title?: string;
  elements: InteractiveElementModel[];
  snapshot?: string;
  lastAction?: string;
  error?: string;
}

export interface AutomationEvent {
  name: string;
  payload: Record<string, unknown>;
  timestamp: number;
  duration: number;
  status: "ok" | "warning" | "error";
}
