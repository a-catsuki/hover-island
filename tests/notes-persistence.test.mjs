import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/components/widgets/notesPersistence.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
const { createNotesWriter, flushNotesWriters } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

test('app quit flushes a pending debounce and waits for the in-flight note write', async () => {
  const saved = []
  let releaseWrite
  const writer = createNotesWriter((value) => {
    saved.push(value)
    return new Promise((resolve) => { releaseWrite = resolve })
  }, 5000)

  writer.schedule('superseded')
  writer.schedule('latest note')
  const unmountFlush = writer.dispose()
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(saved, ['latest note'])

  let appFlushFinished = false
  const appFlush = flushNotesWriters().then(() => { appFlushFinished = true })
  await Promise.resolve()
  assert.equal(appFlushFinished, false, 'quit flush must wait for the notes IPC call')

  releaseWrite()
  await Promise.all([unmountFlush, appFlush])
  assert.equal(appFlushFinished, true)
  assert.deepEqual(saved, ['latest note'])
})
