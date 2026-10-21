export const FIRST_RUN_STEP_COUNT = 7

export function shouldShowFirstRun(settingsLoaded: boolean, savedVersion: number | null | undefined): boolean {
  return settingsLoaded && (savedVersion == null || savedVersion === 0)
}
