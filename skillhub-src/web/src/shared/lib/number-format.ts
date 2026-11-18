export function formatCompactCount(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000
    return `${stripTrailingZero(millions)}M`
  }

  if (value >= 1_000) {
    const thousands = value / 1_000
    return `${stripTrailingZero(thousands)}K`
  }

  return String(value)
}

/** Renders a 0-100 percentage metric; null/undefined renders as an em dash. */
export function formatPercent(value: number | null | undefined): string {
  return value == null ? '—' : `${value.toFixed(1)}%`
}

/** Renders a duration in hours; null/undefined renders as an em dash. */
export function formatHours(value: number | null | undefined): string {
  return value == null ? '—' : `${value.toFixed(1)}h`
}

function stripTrailingZero(value: number): string {
  const formatted = value >= 10 ? value.toFixed(0) : value.toFixed(1)
  return formatted.endsWith('.0') ? formatted.slice(0, -2) : formatted
}
