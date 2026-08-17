import type { TelemetryEvent, WorkerSnapshot } from "@/src/core/types";

type ObservatoryEvents = {
  raw: TelemetryEvent[];
  exportProgress: TelemetryEvent;
  snapshot: WorkerSnapshot;
  status: "connecting" | "live" | "paused" | "offline";
};

type Handler<T> = (value: T) => void;

export class EventBus {
  private channels = new Map<keyof ObservatoryEvents, Set<Handler<never>>>();

  on<K extends keyof ObservatoryEvents>(name: K, handler: Handler<ObservatoryEvents[K]>) {
    const channel = this.channels.get(name) ?? new Set();
    channel.add(handler as Handler<never>);
    this.channels.set(name, channel);
    return () => channel.delete(handler as Handler<never>);
  }

  emit<K extends keyof ObservatoryEvents>(name: K, value: ObservatoryEvents[K]) {
    this.channels.get(name)?.forEach((handler) => handler(value as never));
  }
}

export const observatoryBus = new EventBus();
