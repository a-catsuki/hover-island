import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

async function loadTs(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
}

const compact = await loadTs('../src/lib/compactConfig.ts')
const onboarding = await loadTs('../src/lib/onboardingConfig.ts')

test('compact selections are unique, valid and capped to the chosen preset', () => {
  const values = ['clock', 'media', 'clock', 'bogus', 'weather', 'battery']
  assert.deepEqual(compact.normalizeCompactItems(values, 'small'), ['clock', 'media'])
  assert.deepEqual(compact.normalizeCompactItems(values, 'medium'), ['clock', 'media', 'weather'])
  assert.deepEqual(compact.normalizeCompactItems(values, 'large'), ['clock', 'media', 'weather', 'battery'])
  assert.deepEqual(compact.toggleCompactItem(['media', 'clock', 'weather'], 'battery', 'medium'), ['media', 'clock', 'weather'])
})

test('first-run tour waits for settings and does not reappear for saved or legacy versions', () => {
  assert.equal(onboarding.shouldShowFirstRun(false, 0), false)
  assert.equal(onboarding.shouldShowFirstRun(true, 0), true)
  assert.equal(onboarding.shouldShowFirstRun(true, 1), false)
  assert.equal(onboarding.shouldShowFirstRun(true, null), false)
  assert.equal(onboarding.shouldShowFirstRun(true, undefined), false)
})
