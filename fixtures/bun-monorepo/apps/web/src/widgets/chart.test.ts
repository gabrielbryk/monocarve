import { renderChart } from "./chart.ts";
import type { Series } from "../types.ts";

const series: Series = [{ x: 1, y: 2 }];

export function chartRendersPoints(): boolean {
  return renderChart(series).includes("1.0:2.0");
}
