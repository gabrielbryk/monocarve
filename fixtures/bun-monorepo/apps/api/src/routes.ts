import { formatNumber } from "@acme/format";

export interface Route {
  path: string;
  render(): string;
}

export const routes: Route[] = [
  { path: "/", render: () => "ok" },
  { path: "/count", render: () => formatNumber(42) },
];
