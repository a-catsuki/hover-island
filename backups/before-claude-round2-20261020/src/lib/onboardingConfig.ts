export const FIRST_RUN_STEP_COUNT = 4

export function shouldShowFirstRun(settingsLoaded: boolean, savedVersion: number | null | undefined): boolean {
  return settingsLoaded && (savedVersion == null || savedVersion === 0)
}
