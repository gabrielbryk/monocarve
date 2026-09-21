export function formatNumber(value: number): string {
  return value.toFixed(1);
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}
