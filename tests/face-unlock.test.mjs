import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

async function load(path, globals = {}) {
  const source = await readFile(new URL(`../src/${path}`, import.meta.url), 'utf8')
  const exports = {}
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, { exports, module: { exports }, setTimeout, clearTimeout, AbortController, console, ...globals })
  return exports
}

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('one scan budget includes startup and inference, and clears timers after a first-frame match', async () => {
  let now = 0, next = 0
  const timers = new Map()
  const { FaceScan, FACE_SCAN_MS, FaceScanExpired } = await load('lib/faceScan.ts', {
    Date: { now: () => now },
    setTimeout: (callback, ms) => { timers.set(++next, { callback, ms }); return next },
    clearTimeout: id => timers.delete(id),
  })
  const scan = new FaceScan(FACE_SCAN_MS)
  const camera = deferred()
  const starting = scan.wait(camera.promise)
  now = 1800
  camera.resolve()
  await starting
  assert.equal(timers.size, 0)
  const frame = deferred()
  const reading = scan.wait(frame.promise)
  assert.equal([...timers.values()][0].ms, 700, 'camera startup is part of the same 2.5 s budget')
  frame.resolve('match')
  assert.equal(await reading, 'match')
  assert.equal(timers.size, 0, 'successful frames leave no timeout behind')
  const stalled = scan.wait(new Promise(() => {}))
  now = 2500
  const expired = assert.rejects(stalled, FaceScanExpired)
  ;[...timers.values()][0].callback()
  await expired
  assert.equal(timers.size, 0)
})

test('a cancelled scan settles promptly and ignores late results and rejections', async () => {
  const { FaceScan, FaceScanCancelled } = await load('lib/faceScan.ts')
  const scan = new FaceScan(2500)
  const frame = deferred()
  const reading = scan.wait(frame.promise)
  const cancelled = assert.rejects(reading, FaceScanCancelled)
  scan.cancel()
  await cancelled
  frame.reject(new Error('late GPU failure'))
  await Promise.resolve()
  await assert.rejects(scan.wait(Promise.resolve('late match')), FaceScanCancelled)
})

test('an inference that blocks past the deadline cannot return a late match', async () => {
  let now = 0
  const { FaceScan, FaceScanExpired } = await load('lib/faceScan.ts', { Date: { now: () => now } })
  const scan = new FaceScan(2500)
  const frame = deferred()
  const reading = scan.wait(frame.promise)
  now = 3000
  frame.resolve('match')
  await assert.rejects(reading, FaceScanExpired)
})

test('a camera arriving after stop is released and cannot replace the next camera request', async () => {
  const requests = []
  const video = { readyState: 4, srcObject: null, play: async () => {} }
  const { FaceCamera } = await load('ambient/face.ts', {
    navigator: { mediaDevices: { getUserMedia: () => {
      const request = deferred(); requests.push(request); return request.promise
    } } },
    document: { createElement: () => video },
    HTMLMediaElement: { HAVE_FUTURE_DATA: 3 },
  })
  const camera = new FaceCamera()
  const old = camera.start()
  camera.stop()
  const current = camera.start()
  assert.equal(current, camera.start(), 'concurrent starts share a single request')
  let oldStops = 0, currentStops = 0
  const oldStream = { getTracks: () => [{ stop: () => oldStops++ }] }
  const newStream = { getTracks: () => [{ stop: () => currentStops++ }] }
  const cancelled = assert.rejects(old, /cancelled/)
  requests[0].resolve(oldStream)
  await cancelled
  assert.equal(oldStops, 1)
  assert.equal(video.srcObject, null)
  assert.equal(current, camera.start(), 'the old finally must not clear the current start')
  requests[1].resolve(newStream)
  await current
  assert.equal(camera.running, true)
  assert.equal(video.srcObject, newStream)
  camera.stop()
  assert.equal(currentStops, 1)
  assert.equal(camera.running, false)
  assert.equal(video.srcObject, null)
})

test('a failed video start releases its stream so retry can open the camera again', async () => {
  let stops = 0
  const { FaceCamera } = await load('ambient/face.ts', {
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => stops++ }] }) } },
    document: { createElement: () => ({ srcObject: null, play: async () => { throw new Error('camera busy') } }) },
  })
  const camera = new FaceCamera()
  await assert.rejects(camera.start(), /camera busy/)
  assert.equal(stops, 1)
  assert.equal(camera.running, false)
  await assert.rejects(camera.start(), /camera busy/)
  assert.equal(stops, 2)
})

test('one decoded camera frame is sufficient without waiting for future buffered frames', async () => {
  const { FaceCamera } = await load('ambient/face.ts', {
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
    document: { createElement: () => ({ readyState: 2, srcObject: null, play: async () => {}, addEventListener() { throw new Error('should not wait for another frame') } }) },
    HTMLMediaElement: { HAVE_CURRENT_DATA: 2, HAVE_FUTURE_DATA: 3 },
  })
  const camera = new FaceCamera()
  await camera.start()
  assert.equal(camera.running, true)
  camera.stop()
})

test('hiding ambient cancels a pending first-frame wait and removes its listener', async () => {
  const listeners = new Map()
  const attached = deferred()
  let stopped = 0
  const { FaceCamera } = await load('ambient/face.ts', {
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => stopped++ }] }) } },
    document: { createElement: () => ({ readyState: 1, srcObject: null, play: async () => {}, addEventListener: (name, fn) => { listeners.set(name, fn); attached.resolve() }, removeEventListener: name => listeners.delete(name) }) },
    HTMLMediaElement: { HAVE_CURRENT_DATA: 2 },
  })
  const camera = new FaceCamera()
  const opening = camera.start()
  await attached.promise
  assert.equal(listeners.size, 1)
  const cancelled = assert.rejects(opening, /cancelled/)
  camera.stop()
  await cancelled
  assert.equal(listeners.size, 0)
  assert.equal(stopped, 1)
})
