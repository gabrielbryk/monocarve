import { formatNumber } from "@acme/format";

import type { Point, Series } from "../types.ts";
import "./chart.css";

export function renderChart(series: Series): string {
  const points = series.map(toLabel).join(" ");
  return `<div class="chart">${points}</div>`;
}

function toLabel(point: Point): string {
  return `${formatNumber(point.x)}:${formatNumber(point.y)}`;
}
