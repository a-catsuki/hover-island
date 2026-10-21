import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const source = await readFile(new URL('../src/state/notifications.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText

function accessState(status, granted, saveError) {
  const calls = { requested: 0, flushed: 0, patches: [] }
  const signal = value => [() => value, next => { value = next }]
  const mocks = {
    'solid-js': { createSignal: signal, createMemo: fn => fn },
    '../lib/ipc': { cmd: {
      notificationsAccessStatus: async () => ({ packaged: true, status }),
      notificationsAccess: async () => { calls.requested++; return granted },
    } },
    './feedback': { reportError: () => {} },
    './settings': {
      settings: { modules: { notifications: false, media: true }, notifications: { enabled: false, systemListener: false, sound: 'soft' } },
      patchSettings: patch => calls.patches.push(patch),
      flushSettings: async () => { calls.flushed++; if (saveError) throw saveError },
    },
  }
  const exported = {}
  vm.runInNewContext(compiled, { exports: exported, require: name => mocks[name] })
  return { calls, request: exported.requestNotificationAccess }
}

test('an existing Windows grant resumes and persists capture without prompting again', async () => {
  const { calls, request } = accessState('allowed', false)
  assert.equal(await request(), true)
  assert.equal(calls.requested, 0)
  assert.equal(calls.flushed, 1)
  assert.equal(calls.patches[0].modules.notifications, true)
  assert.equal(calls.patches[0].modules.media, true)
  assert.equal(calls.patches[0].notifications.systemListener, true)
  assert.equal(calls.patches[0].notifications.sound, 'soft')
})

test('a denied grant cannot be retried and does not pretend capture was enabled', async () => {
  const { calls, request } = accessState('denied', false)
  assert.equal(await request(), false)
  assert.equal(calls.requested, 0)
  assert.equal(calls.flushed, 0)
  assert.equal(calls.patches.length, 0)
})

test('a newly granted request waits for preferences to save before reporting success', async () => {
  const { calls, request } = accessState('not-requested', true, new Error('Preferences unavailable'))
  await assert.rejects(request(), /Preferences unavailable/)
  assert.equal(calls.requested, 1)
  assert.equal(calls.flushed, 1)
})
