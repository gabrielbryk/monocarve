import { logger } from "@acme/logger";

import { renderChart } from "./widgets/chart.ts";
import type { Point } from "./types.ts";

const series: Point[] = [
  { x: 0, y: 1 },
  { x: 1, y: 4 },
  { x: 2, y: 9 },
];

export function start(mount: HTMLElement): void {
  logger.info("web starting");
  mount.innerHTML = renderChart(series);
}
