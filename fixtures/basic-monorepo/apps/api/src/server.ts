import { logger } from "@acme/logger";

import { routes } from "./routes.ts";

export function handle(path: string): string {
  const route = routes.find((entry) => entry.path === path);
  if (!route) {
    logger.warn(`no route for ${path}`);
    return "404";
  }
  return route.render();
}
