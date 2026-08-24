import { create } from "zustand";
import { deleteAutomationWorkflow, loadAutomationWorkflows, saveAutomationWorkflow } from "./artifact-store";
import type { AutomationSession, AutomationStep, AutomationWorkflow } from "./types";

const initialSession: AutomationSession = { status: "idle", elements: [] };

interface AutomationState {
  workflows: AutomationWorkflow[];
  activeWorkflowId?: string;
  session: AutomationSession;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setSession: (session: Partial<AutomationSession>) => void;
  createWorkflow: (startUrl: string) => string;
  updateWorkflow: (patch: Partial<AutomationWorkflow>) => void;
  deleteWorkflow: (id: string) => void;
  selectWorkflow: (id: string) => void;
  addStep: (step: AutomationStep) => void;
  updateStep: (id: string, patch: Partial<AutomationStep>) => void;
  removeStep: (id: string) => void;
  moveStep: (id: string, direction: -1 | 1) => void;
  markStep: (id: string, patch: Partial<AutomationStep>) => void;
  clear: () => void;
}

const active = (state: AutomationState) => state.workflows.find((workflow) => workflow.id === state.activeWorkflowId);
const persist = (workflow?: AutomationWorkflow) => { if (workflow) void saveAutomationWorkflow(workflow).catch(() => undefined); };

export const useAutomationStore = create<AutomationState>((set, get) => ({
  workflows: [],
  activeWorkflowId: undefined,
  session: initialSession,
  hydrated: false,
  hydrate: async () => {
    if (get().hydrated) return;
    const workflows = await loadAutomationWorkflows().catch(() => []);
    set({ workflows, activeWorkflowId: workflows[0]?.id, hydrated: true });
  },
  setSession: (patch) => set((state) => ({ session: { ...state.session, ...patch } })),
  createWorkflow: (startUrl) => {
    const now = Date.now();
    const workflow: AutomationWorkflow = { id: `workflow-${now}`, name: "Untitled workflow", startUrl, steps: [], createdAt: now, updatedAt: now, lastRunStatus: "idle" };
    set((state) => ({ workflows: [workflow, ...state.workflows], activeWorkflowId: workflow.id }));
    persist(workflow);
    return workflow.id;
  },
  updateWorkflow: (patch) => set((state) => {
    const current = active(state);
    if (!current) return state;
    const workflow = { ...current, ...patch, updatedAt: Date.now() };
    persist(workflow);
    return { workflows: state.workflows.map((item) => item.id === workflow.id ? workflow : item) };
  }),
  deleteWorkflow: (id) => {
    void deleteAutomationWorkflow(id).catch(() => undefined);
    set((state) => {
      const workflows = state.workflows.filter((workflow) => workflow.id !== id);
      return { workflows, activeWorkflowId: state.activeWorkflowId === id ? workflows[0]?.id : state.activeWorkflowId };
    });
  },
  selectWorkflow: (id) => set({ activeWorkflowId: id }),
  addStep: (step) => set((state) => {
    const current = active(state);
    if (!current) return state;
    const workflow = { ...current, steps: [...current.steps, step], updatedAt: Date.now(), lastRunStatus: "idle" as const };
    persist(workflow);
    return { workflows: state.workflows.map((item) => item.id === workflow.id ? workflow : item) };
  }),
  updateStep: (id, patch) => set((state) => {
    const current = active(state);
    if (!current) return state;
    const workflow = { ...current, steps: current.steps.map((step) => step.id === id ? { ...step, ...patch } : step), updatedAt: Date.now() };
    persist(workflow);
    return { workflows: state.workflows.map((item) => item.id === workflow.id ? workflow : item) };
  }),
  removeStep: (id) => get().updateWorkflow({ steps: active(get())?.steps.filter((step) => step.id !== id) ?? [] }),
  moveStep: (id, direction) => set((state) => {
    const current = active(state);
    if (!current) return state;
    const index = current.steps.findIndex((step) => step.id === id);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= current.steps.length) return state;
    const steps = [...current.steps];
    [steps[index], steps[next]] = [steps[next], steps[index]];
    const workflow = { ...current, steps, updatedAt: Date.now() };
    persist(workflow);
    return { workflows: state.workflows.map((item) => item.id === workflow.id ? workflow : item) };
  }),
  markStep: (id, patch) => get().updateStep(id, patch),
  clear: () => set({ workflows: [], activeWorkflowId: undefined }),
}));
