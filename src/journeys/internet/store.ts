import { create } from "zustand";
import { internetJourneyNodes } from "./data";

interface InternetJourneyState {
  cursor: number;
  playing: boolean;
  speed: .5 | 1 | 2;
  mode: "education" | "developer";
  query: string;
  expanded?: string;
  play: (playing: boolean) => void;
  seek: (cursor: number) => void;
  setSpeed: (speed: .5 | 1 | 2) => void;
  setMode: (mode: "education" | "developer") => void;
  setQuery: (query: string) => void;
  toggle: (id: string) => void;
}

export const useInternetJourneyStore = create<InternetJourneyState>((set) => ({
  cursor: internetJourneyNodes.length - 1, playing: false, speed: 1, mode: "education", query: "",
  play: (playing) => set({ playing }),
  seek: (cursor) => set({ cursor: Math.max(0, Math.min(internetJourneyNodes.length - 1, cursor)) }),
  setSpeed: (speed) => set({ speed }), setMode: (mode) => set({ mode }), setQuery: (query) => set({ query }),
  toggle: (id) => set((state) => ({ expanded: state.expanded === id ? undefined : id })),
}));
