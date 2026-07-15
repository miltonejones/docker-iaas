export function bytes(n: number | undefined | null): string {
  if (!n || n < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export interface ImpactInfo {
  onDiskLabel: string;
  downloadLabel: string;
  /** onDisk as a share of current host free space, or null if unknown. */
  percentOfFree: number | null;
  /** ok = negligible, warn = a noticeable bite, crit = won't fit in free space. */
  level: 'ok' | 'warn' | 'crit';
  fits: boolean;
}

/**
 * Weigh a preset's on-disk footprint against real free space so the launch UI
 * can show impact ("~160 MB · 0.06% of free") and flag anything heavy.
 */
export function diskImpact(
  impact: { download: number; onDisk: number } | undefined,
  freeBytes: number | null | undefined,
): ImpactInfo | null {
  if (!impact) return null;
  const percentOfFree = freeBytes && freeBytes > 0 ? (impact.onDisk / freeBytes) * 100 : null;
  const fits = freeBytes == null || impact.onDisk < freeBytes;
  let level: ImpactInfo['level'] = 'ok';
  if (!fits) level = 'crit';
  else if (percentOfFree != null && percentOfFree >= 5) level = 'warn';
  return {
    onDiskLabel: bytes(impact.onDisk),
    downloadLabel: bytes(impact.download),
    percentOfFree,
    level,
    fits,
  };
}

export function timeAgo(epochSeconds: number): string {
  const secs = Math.max(0, Date.now() / 1000 - epochSeconds);
  const table: [number, string][] = [
    [86400, 'd'],
    [3600, 'h'],
    [60, 'm'],
  ];
  for (const [unit, label] of table) {
    if (secs >= unit) return `${Math.floor(secs / unit)}${label} ago`;
  }
  return 'just now';
}
