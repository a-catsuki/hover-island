import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const source = await readFile(new URL('../src/lib/appearance.ts', import.meta.url), 'utf8')
const exported = {}
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: exported, module: { exports: exported } })
const base = {
  theme: 'midnight', accent: '#0a84ff', background: 'plain', opacity: 0.96, sizePreset: 'medium',
  collapsed: { w: 320, h: 38 }, expanded: { w: 620, h: 440 }, clockTypography: 'rounded', clockHourCycle: '12',
  clockSeconds: false, compactClockStyle: 'digital', compactItems: ['media', 'clock'], placement: { mode: 'notch', edge: 'top' }, panelNames: {},
}

test('every appearance field changes the key an open island watches', () => {
  const key = exported.appearanceKey(base)
  assert.equal(exported.appearanceKey({ ...base }), key)
  const changes = {
    theme: 'frost', accent: '#ff375f', background: 'ember', opacity: 0.9, sizePreset: 'small',
    collapsed: { w: 300, h: 38 }, expanded: { w: 500, h: 420 }, clockTypography: 'serif', clockHourCycle: '24',
    clockSeconds: true, compactClockStyle: 'analog', compactItems: ['clock'], placement: { mode: 'bar', edge: 'top' }, panelNames: { today: 'Home' },
  }
  for (const [field, value] of Object.entries(changes)) assert.notEqual(exported.appearanceKey({ ...base, [field]: value }), key, field)
})
