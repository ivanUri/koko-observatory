"use client";

import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import {
  DataZoomComponent,
  GridComponent,
  TooltipComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { useTelemetryStore } from "@/src/stores";

echarts.use([LineChart, GridComponent, TooltipComponent, DataZoomComponent, CanvasRenderer]);

export function RealtimeChart() {
  const ref = useRef<HTMLDivElement>(null);
  const instance = useRef<echarts.ECharts | undefined>(undefined);
  const rate = useTelemetryStore((state) => state.rate);

  useEffect(() => {
    if (!ref.current) return;
    instance.current = echarts.init(ref.current, undefined, { renderer: "canvas" });
    const resize = () => instance.current?.resize();
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      instance.current?.dispose();
    };
  }, []);

  useEffect(() => {
    instance.current?.setOption({
      animation: false,
      grid: { left: 4, right: 10, top: 15, bottom: 24, containLabel: true },
      tooltip: {
        trigger: "axis",
        backgroundColor: "#14171d",
        borderColor: "#29303a",
        textStyle: { color: "#dce2ea", fontSize: 11 },
      },
      xAxis: {
        type: "time",
        boundaryGap: false,
        axisLine: { lineStyle: { color: "#252b34" } },
        axisLabel: { color: "#667080", fontSize: 10 },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        min: 0,
        axisLabel: { color: "#667080", fontSize: 10 },
        splitLine: { lineStyle: { color: "#1d2229" } },
      },
      dataZoom: [{ type: "inside", start: 30, end: 100 }],
      series: [
        {
          type: "line",
          data: rate,
          showSymbol: false,
          sampling: "lttb",
          lineStyle: { color: "#8b7cff", width: 1.5 },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: "rgba(139,124,255,.28)" },
              { offset: 1, color: "rgba(139,124,255,0)" },
            ]),
          },
        },
      ],
    });
  }, [rate]);

  return <div ref={ref} className="h-[245px] w-full" aria-label="Realtime event throughput" />;
}
