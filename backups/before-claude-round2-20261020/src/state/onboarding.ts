import { batch, createSignal } from 'solid-js'
import { patchSettings } from './settings'
import { FIRST_RUN_STEP_COUNT, shouldShowFirstRun } from '../lib/onboardingConfig'

export const FIRST_RUN_VERSION = 1
const lastStepIndex = Math.max(0, FIRST_RUN_STEP_COUNT - 1)
const [onboardingOpen, setOnboardingOpen] = createSignal(false)
const [onboardingStep, setOnboardingStep] = createSignal(0)

export { shouldShowFirstRun, FIRST_RUN_STEP_COUNT }

export function beginFirstRun(): void {
  setOnboardingStep(0)
  setOnboardingOpen(true)
}

export function nextOnboardingStep(): void {
  setOnboardingStep(step => Math.min(lastStepIndex, step + 1))
}

export function previousOnboardingStep(): void {
  setOnboardingStep(step => Math.max(0, step - 1))
}

export function goToOnboardingStep(index: number): void {
  if (!Number.isFinite(index)) return
  setOnboardingStep(Math.max(0, Math.min(lastStepIndex, Math.trunc(index))))
}

export function finishFirstRun(): void {
  batch(() => {
    patchSettings({ onboardingVersion: FIRST_RUN_VERSION })
    setOnboardingOpen(false)
  })
}

export function replayFirstRun(): void {
  patchSettings({ onboardingVersion: 0 })
}

export { onboardingOpen, onboardingStep }
