const GB = 1_000_000_000
const MB = 1_000_000

export function formatBytes(bytes: number, locale: string): string {
  if (bytes >= GB) {
    const value = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / GB)
    return `${value} GB`
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(bytes / MB)} MB`
}
