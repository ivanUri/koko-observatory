"use client";

import { useEffect, useMemo, useRef } from "react";
import * as echarts from "echarts/core";
import { CustomChart } from "echarts/charts";
import { DataZoomComponent, GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([CustomChart, DataZoomComponent, GridComponent, TooltipComponent, CanvasRenderer]);

export interface TimelineChartEvent {
  id: string;
  lane: string;
  timestamp: number;
  duration: number;
  status: "ok" | "warning" | "error";
  name: string;
  kind: string;
  journey: string;
  sessionId: string;
}

interface TimelineChartProps {
  events: TimelineChartEvent[];
  lanes: string[];
  start: number;
  end: number;
  selectedId?: string;
  onSelect: (id: string) => void;
}

const colors = {
  ok: "#42cfa2",
  warning: "#d3a644",
  error: "#d75b67",
};

export function TimelineChart({ events, lanes, start, end, selectedId, onSelect }: TimelineChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const instance = useRef<echarts.ECharts | undefined>(undefined);
  const chartData = useMemo(() => events.map((event) => ({
    value: [lanes.indexOf(event.lane), event.timestamp, event.timestamp + Math.max(event.duration, 0.25)],
    item: event,
  })), [events, lanes]);
  const chartDataRef = useRef(chartData);
  const onSelectRef = useRef(onSelect);
  chartDataRef.current = chartData;
  onSelectRef.current = onSelect;

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current, undefined, { renderer: "canvas" });
    instance.current = chart;
    const resizeObserver = new ResizeObserver(() => chart.resize());
    resizeObserver.observe(ref.current);
    const handleClick = (params: echarts.ECElementEvent) => {
      const index = params.dataIndex;
      if (typeof index !== "number") return;
      const event = chartDataRef.current[index]?.item;
      if (event) onSelectRef.current(event.id);
    };
    chart.on("click", handleClick);
    return () => {
      chart.off("click", handleClick);
      resizeObserver.disconnect();
      chart.dispose();
      instance.current = undefined;
    };
  }, []);

  useEffect(() => {
    if (!instance.current) return;
    instance.current.setOption({
      animation: false,
      grid: { left: 104, right: 22, top: 24, bottom: 58, containLabel: true },
      tooltip: {
        trigger: "item",
        backgroundColor: "#101a22",
        borderColor: "#31505a",
        textStyle: { color: "#d9e8e7", fontSize: 12 },
        formatter: (params: unknown) => {
          const item = typeof params === "object" && params !== null && "data" in params
            ? (params as { data?: { item?: TimelineChartEvent } }).data?.item
            : undefined;
          if (!item) return "";
          return `<strong>${escapeHtml(item.name)}</strong><br/>${escapeHtml(item.journey)} · ${escapeHtml(item.kind)}<br/>${formatOffset(item.duration)} · ${item.status}<br/><span style="color:#829ba3">${escapeHtml(item.sessionId)}</span>`;
        },
      },
      xAxis: {
        type: "time",
        min: start,
        max: Math.max(start + 1, end),
        axisLine: { lineStyle: { color: "#29414b" } },
        axisTick: { lineStyle: { color: "#29414b" } },
        axisLabel: { color: "#77909a", fontSize: 11, hideOverlap: true, showMinLabel: true, showMaxLabel: true, margin: 10, formatter: (value: number) => formatOffset(value - start) },
        splitLine: { show: true, lineStyle: { color: "rgba(104,151,161,.13)" } },
      },
      yAxis: {
        type: "category",
        inverse: true,
        data: lanes,
        axisLine: { lineStyle: { color: "#29414b" } },
        axisTick: { show: false },
        axisLabel: { color: "#a0b6bc", fontSize: 11, formatter: (value: string) => value.charAt(0).toUpperCase() + value.slice(1) },
        splitLine: { show: true, lineStyle: { color: "rgba(104,151,161,.08)" } },
      },
      dataZoom: [
        { type: "inside", xAxisIndex: 0, filterMode: "none", zoomOnMouseWheel: false, moveOnMouseMove: false },
        {
          type: "slider",
          xAxisIndex: 0,
          filterMode: "none",
          height: 16,
          bottom: 20,
          borderColor: "#29414b",
          backgroundColor: "#0b171f",
          fillerColor: "rgba(66,207,162,.18)",
          handleStyle: { color: "#42cfa2", borderColor: "#a1e9cf" },
          textStyle: { color: "#718792", fontSize: 10 },
        },
      ],
      series: [{
        type: "custom",
        renderItem: (params: echarts.CustomSeriesRenderItemParams, api: echarts.CustomSeriesRenderItemAPI) => {
          const laneIndex = api.value(0);
          const eventStart = api.value(1);
          const eventEnd = api.value(2);
          const startPoint = api.coord([eventStart, laneIndex]);
          const endPoint = api.coord([eventEnd, laneIndex]);
          const rowHeight = Array.isArray(api.size?.([0, 1])) ? api.size?.([0, 1]) as number[] : [0, 18];
          const height = Math.max(10, Number(rowHeight[1] ?? 18) * .48);
          const item = chartData[params.dataIndex]?.item;
          if (!item) return undefined;
          const width = Math.max(3, endPoint[0] - startPoint[0]);
          return {
            type: "rect",
            shape: { x: startPoint[0], y: startPoint[1] - height / 2, width, height, r: 3 },
            style: { fill: colors[item.status], opacity: item.id === selectedId ? 1 : .84, stroke: item.id === selectedId ? "#e3fff4" : "transparent", lineWidth: item.id === selectedId ? 2 : 0 },
          };
        },
        encode: { x: [1, 2], y: 0 },
        data: chartData,
      }],
    }, true);
  }, [chartData, end, lanes, selectedId, start]);

  return <div className="timeline-chart"><div ref={ref} className="timeline-chart__canvas" role="img" aria-label="Telemetry event timeline chart" />{!events.length && <div className="timeline-chart__empty">No telemetry matches the current filters.</div>}</div>;
}

function formatOffset(value: number) {
  if (value >= 60_000) return `${(value / 60_000).toFixed(2)} min`;
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  if (value >= 1) return `${value.toFixed(1)} ms`;
  return `${Math.max(0, value * 1000).toFixed(0)} µs`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[character] ?? character));
}
