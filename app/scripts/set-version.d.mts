export interface VersionSources {
  packageJson: string
  pyproject: string
  init: string
}
export function pep440(version: string): string
export function applyVersion(sources: VersionSources, version: string): VersionSources
export function setVersion(root: string, version: string): Promise<void>
