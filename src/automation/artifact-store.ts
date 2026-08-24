import { observatoryDb } from "@/src/data/database";
import type { AutomationWorkflow } from "./types";

export async function loadAutomationWorkflows() {
  if (typeof window === "undefined") return [];
  return observatoryDb.automationWorkflows.orderBy("updatedAt").reverse().toArray();
}

export async function saveAutomationWorkflow(workflow: AutomationWorkflow) {
  if (typeof window !== "undefined") await observatoryDb.automationWorkflows.put(workflow);
}

export async function deleteAutomationWorkflow(id: string) {
  if (typeof window !== "undefined") await observatoryDb.automationWorkflows.delete(id);
}
