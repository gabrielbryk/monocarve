export interface Logger {
  info(message: string): void;
  warn(message: string): void;
}

export const logger: Logger = {
  info(message) {
    console.log(`[info] ${message}`);
  },
  warn(message) {
    console.warn(`[warn] ${message}`);
  },
};
