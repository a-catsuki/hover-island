import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

async function fixture(command) {
  const source = await readFile(new URL('../src/lib/appIcons.ts', import.meta.url), 'utf8')
  const exports = {}
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require: () => ({ cmd: { appsIcon: command } }) })
  return exports
}

test('icon cache evicts by bytes and recency without retaining an oversized image', async () => {
  const counts = new Map()
  const api = await fixture(async id => { counts.set(id, (counts.get(id) ?? 0) + 1); return 'x'.repeat(id === 'oversized' ? 2_000_000 : 400_000) })
  await api.loadAppIcon({ id: 'a' }); await api.loadAppIcon({ id: 'b' })
  await api.loadAppIcon({ id: 'a' }); await api.loadAppIcon({ id: 'c' })
  await api.loadAppIcon({ id: 'a' })
  assert.equal(counts.get('a'), 1)
  await api.loadAppIcon({ id: 'b' })
  assert.equal(counts.get('b'), 2)
  await api.loadAppIcon({ id: 'oversized' }); await api.loadAppIcon({ id: 'oversized' })
  assert.equal(counts.get('oversized'), 2)
})

test('a catalogue flood has four workers and a bounded queue', async () => {
  let active = 0, peak = 0
  const finish = []
  const api = await fixture(() => new Promise(resolve => { peak = Math.max(peak, ++active); finish.push(() => { active--; resolve('x'.repeat(100)) }) }))
  const work = Array.from({ length: 2000 }, (_, id) => api.loadAppIcon({ id: String(id) }))
  let placeholders = 0
  for (const item of work) item.then(value => { if (!value) placeholders++ })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(peak, 4)
  assert.equal(placeholders, 2000 - 96)
  while (finish.length || active) {
    finish.splice(0).forEach(done => done())
    await new Promise(resolve => setImmediate(resolve))
  }
  await Promise.all(work)
  assert.equal(peak, 4)
})
