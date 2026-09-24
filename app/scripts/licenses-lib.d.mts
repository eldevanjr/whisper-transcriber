export interface LicenseEntry {
  name: string
  version: string
  license: string
  url: string
  text: string
}
export function fromLicenseChecker(
  report: Record<string, Record<string, unknown>>,
  ownName: string
): LicenseEntry[]
export function fromPipLicenses(
  report: Record<string, string>[],
  runtime: Set<string>
): LicenseEntry[]
export const FIXED_NOTICES: LicenseEntry[]
export function mergeLicenses(groups: LicenseEntry[][]): LicenseEntry[]
export function findForbidden(entries: LicenseEntry[]): string[]
export function normalizeName(name: string): string
