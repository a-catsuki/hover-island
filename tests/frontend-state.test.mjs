import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const root = new URL('../', import.meta.url)

function signal(initial) {
  let value = initial
  return [() => value, next => { value = typeof next === 'function' ? next(value) : next }]
}

async function importTs(relativePath, mocks, globals = {}) {
  if (relativePath === 'src/state/settings.ts' && !Object.hasOwn(mocks, '../lib/panels')) {
    const widgetPages = await importTs('src/lib/widgetPages.ts', {})
    mocks = { ...mocks, '../lib/panels': await importTs('src/lib/panels.ts', { './widgetPages': widgetPages }) }
  }
  const source = await readFile(new URL(relativePath, root), 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const exported = {}
  const context = vm.createContext({
    exports: exported,
    module: { exports: exported },
    require: name => {
      if (Object.hasOwn(mocks, name)) return mocks[name]
      throw new Error(`Unexpected import in ${relativePath}: ${name}`)
    },
    setTimeout,
    clearTimeout,
    console,
    ...globals,
  })
  vm.runInContext(js, context, { filename: relativePath })
  return context.module.exports
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

test('repeated polling failures expire instead of extending or resurrecting their banner', async () => {
  let now=100, next=0
  const timers=new Map()
  const module=await importTs('src/state/feedback.ts',{'solid-js':{createSignal:signal}}, {
    Date:{now:()=>now},setTimeout:fn=>{timers.set(++next,fn);return next},clearTimeout:id=>timers.delete(id),
  })
  module.reportError('Brightness','Unavailable')
  assert.equal(timers.size,1)
  const first=[...timers.values()][0]
  now+=3000;module.reportError('Brightness','Unavailable')
  assert.equal([...timers.values()][0],first)
  now+=3000;first();assert.equal(module.feedback(),'')
  module.reportError('Brightness','Unavailable');assert.equal(module.feedback(),'')
  module.reportError('Volume','Unavailable');assert.match(module.feedback(),/^Volume/)
  module.reportError('Brightness','Unavailable');assert.match(module.feedback(),/^Volume/)
  module.dismissFeedback();module.reportError('Volume','Unavailable');assert.equal(module.feedback(),'')
  now+=30001;module.reportError('Volume','Unavailable');assert.match(module.feedback(),/^Volume/)
})

test('a successful Beam refresh clears a prior transient connection error', async () => {
  let failed = true
  const module = await importTs('src/state/transfer.ts', {
    'solid-js': { createSignal: signal },
    '../lib/ipc': { browserPreview: false, cmd: { transferStatus: async () => {
      if (failed) throw new Error('Temporarily offline')
      return { active: true, files: [{id:'f',name:'Photo.jpg',size:12,createdAt:1}], error:null }
    } } },
  })
  await module.refreshTransfer()
  assert.match(module.transfer().error, /Temporarily offline/)
  failed = false
  await module.refreshTransfer()
  assert.equal(module.transfer().error, null)
  assert.equal(module.transfer().files.length, 1)
})

test('native slider writes serialize and the final drag value wins', async () => {
  const { createSliderCommitter } = await importTs('src/lib/sliderCommitter.ts', {})
  const writes = [], first = deferred(), second = deferred(), errors = []
  const committer = createSliderCommitter(value => {
    writes.push(value)
    return writes.length === 1 ? first.promise : second.promise
  }, error => errors.push(error), 0)
  committer.push(10); committer.flush()
  committer.push(35); committer.push(82); committer.flush()
  assert.deepEqual(writes, [10])
  first.resolve()
  await until(() => writes.length === 2, 'latest slider value should follow the active write')
  assert.deepEqual(writes, [10, 82])
  committer.cancel()
  second.reject(new Error('late native response'))
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(errors, [])
})

async function until(predicate, message) {
  for (let i = 0; i < 30; i++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  assert.fail(message)
}

test('slider readback runs only after the last queued native write settles', async () => {
  const {createSliderCommitter}=await importTs('src/lib/sliderCommitter.ts',{})
  const first=deferred(),last=deferred(),writes=[]
  let settled=0
  const committer=createSliderCommitter(value=>{writes.push(value);return writes.length===1?first.promise:last.promise},()=>{},0,()=>settled++)
  committer.push(20);committer.flush();committer.push(60);committer.flush()
  assert.equal(committer.isPending(),true)
  first.resolve();await until(()=>writes.length===2,'final slider write starts')
  assert.equal(settled,0);assert.equal(committer.isPending(),true)
  last.resolve();await until(()=>settled===1,'readback follows final write')
  assert.equal(committer.isPending(),false);assert.deepEqual(writes,[20,60])
  committer.cancel()
})

test('a status poll from before Stop cannot restore the old file session', async () => {
  const poll = deferred()
  const bucket = await importTs('src/state/transfer.ts', {
    'solid-js': { createSignal: signal },
    '../lib/ipc': { browserPreview: false, cmd: {
      transferStatus: () => poll.promise,
      transferStop: async () => {},
    } },
  })
  const polling = bucket.refreshTransfer()
  assert.equal(await bucket.stopTransfer(), null)
  poll.resolve({ active: true, files: [], desktopUrl: 'http://127.0.0.1:1234/s/old' })
  await polling
  assert.equal(bucket.transfer().active, false)
  assert.equal(bucket.transfer().desktopUrl, null)
})

test('hover opens only after the configured sustained delay and cancels on exit', async () => {
  const hover = await importTs('src/state/hover.ts', {})
  assert.equal(hover.shouldExpandAfterSustainedHover(100, 239, 140, true), false)
  assert.equal(hover.shouldExpandAfterSustainedHover(100, 240, 140, true), true)
  assert.equal(hover.shouldExpandAfterSustainedHover(100, 500, 140, false), false)
})

test('Stop cancels queued files and coalesced starts without reopening the bucket', async () => {
  const starting = deferred()
  let starts = 0, stops = 0
  const bucket = await importTs('src/state/transfer.ts', {
    'solid-js': { createSignal: signal },
    '../lib/ipc': { browserPreview: false, cmd: {
      transferStart: () => { starts++; return starting.promise },
      transferStop: async () => { stops++ },
    } },
  })
  const startOne = bucket.startTransfer(), startTwo = bucket.startTransfer()
  assert.equal(startOne, startTwo)
  await until(() => starts === 1, 'start did not run')
  const results = Promise.allSettled([
    bucket.transferUpload({ name:'one.txt', size:3 }),
    bucket.transferUpload({ name:'two.txt', size:3 }),
  ])
  const stopping = bucket.stopTransfer()
  starting.resolve({ active:true, files:[], desktopUrl:'http://127.0.0.1:1234/s/old' })
  await stopping
  assert.ok((await results).every(result => result.status === 'rejected'))
  assert.equal(starts,1)
  assert.equal(stops,1)
  assert.equal(bucket.transfer().active,false)
})

test('audio capture stays ambient until a valid system spectrum arrives', async () => {
  let spectrumListener
  let starts = 0
  let stops = 0
  const audio = await importTs('src/state/audio.ts', {
    'solid-js': { createSignal: signal },
    '../lib/ipc': {
      cmd: {
        audioLoopbackStart: async () => { starts++ },
        audioLoopbackStop: async () => { stops++ },
      },
      onAudioSpectrum: async callback => {
        spectrumListener = callback
        return () => {}
      },
      onAudioSpectrumError: async () => () => {},
    },
  })

  const release = await audio.subscribeAudioSpectrum()
  assert.equal(starts, 1)
  assert.equal(audio.audioCaptureStatus(), 'starting')

  spectrumListener({ bands: Array(23).fill(0.4) })
  assert.equal(audio.audioCaptureStatus(), 'starting')

  spectrumListener({ bands: Array(24).fill(0.4) })
  assert.equal(audio.audioCaptureStatus(), 'active')
  assert.equal(audio.audioSpectrum().length, 24)
  release()
  await until(() => stops === 1, 'final audio subscriber did not stop loopback')
})

test('audio endpoint errors can restart the one shared loopback capture', async () => {
  let spectrumListener
  let errorListener
  let starts = 0
  let stops = 0
  const audio = await importTs('src/state/audio.ts', {
    'solid-js': { createSignal: signal },
    '../lib/ipc': {
      cmd: {
        audioLoopbackStart: async () => { starts++ },
        audioLoopbackStop: async () => { stops++ },
      },
      onAudioSpectrum: async callback => {
        spectrumListener = callback
        return () => {}
      },
      onAudioSpectrumError: async callback => {
        errorListener = callback
        return () => {}
      },
    },
  })

  const release = await audio.subscribeAudioSpectrum()
  assert.equal(starts, 1)
  spectrumListener({ bands: Array(24).fill(0.15) })
  assert.equal(audio.audioCaptureStatus(), 'active')

  errorListener('default output changed')
  assert.equal(audio.audioCaptureStatus(), 'error')
  assert.equal(audio.audioCaptureError(), 'default output changed')

  await audio.retryAudioCapture()
  assert.equal(stops, 1)
  assert.equal(starts, 2)
  assert.equal(audio.audioCaptureStatus(), 'starting')

  spectrumListener({ bands: Array(24).fill(0.3) })
  assert.equal(audio.audioCaptureStatus(), 'active')
  assert.equal(audio.audioSpectrum()[0], 0.3)
  release()
  await until(() => stops === 2, 'recovered loopback was not stopped on final release')
})

test('ambient audio drive amplifies real broadband energy while rejecting isolated noise', async () => {
  const metrics = await importTs('src/lib/audioMetrics.ts', {})
  assert.deepEqual({ ...metrics.audioMetrics(Array(24).fill(0)) }, { energy: 0, bass: 0 })
  assert.equal(metrics.audioMetrics([0.04, ...Array(23).fill(0)]).energy, 0)
  const syntheticMusic = metrics.audioMetrics(Array(24).fill(0.2))
  assert.ok(syntheticMusic.energy > 0.9, 'broadband music should visibly drive the ambient wash')
  assert.ok(syntheticMusic.bass > 0.9, 'low-frequency energy should visibly swell the secondary light')
  const ordinaryOutput = Array(24).fill(0.04)
  assert.ok(metrics.audioMetrics(ordinaryOutput).energy > 0.2, 'ordinary WASAPI levels should create visible light movement')
  assert.ok(metrics.audioFrequencyMetrics(Array(24).fill(0.08)).mids > 0.1, 'midrange output should drive its own ambient field')
  const invalid = metrics.audioMetrics([Number.NaN, ...Array(23).fill(0.08)])
  assert.ok(Number.isFinite(invalid.energy) && invalid.energy < syntheticMusic.energy)
})

test('visualizer gate and bounded adaptive gain preserve quiet music and reject silence or a lone bin', async () => {
  const metrics = await importTs('src/lib/audioMetrics.ts', {})
  const quiet = Array(24).fill(0.00598)
  const louder = Array(24).fill(0.026)
  const silence = Array(24).fill(0)
  const loneBin = [0.8, ...Array(23).fill(0)]
  assert.equal(metrics.isMeaningfulSpectrum(quiet), true, 'quiet broadband output remains live')
  assert.equal(metrics.isMeaningfulSpectrum(louder), true)
  assert.equal(metrics.isMeaningfulSpectrum(silence), false)
  assert.equal(metrics.isMeaningfulSpectrum(loneBin), false, 'an isolated hot FFT bin is treated as noise')
  const quietLevels = metrics.adaptSpectrumLevels(quiet, Array(24).fill(0.008), true).levels
  const loudLevels = metrics.adaptSpectrumLevels(louder, Array(24).fill(0.008), true).levels
  const rejectedLevels = metrics.adaptSpectrumLevels(loneBin, Array(24).fill(0.008), false).levels
  const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length
  assert.ok(mean(quietLevels) > 0.1, 'valid quiet audio gets bounded makeup gain')
  assert.ok(mean(loudLevels) > mean(quietLevels), 'louder audio remains perceptibly stronger')
  assert.ok(mean(loudLevels) < 0.7, 'soft knee limits gain on louder output')
  assert.equal(mean(rejectedLevels), 0)
})

test('audio light drive stays quiet-to-loud, dt-stable, and detects bass onsets', async () => {
  const metrics = await importTs('src/lib/audioMetrics.ts', {})
  const quiet = metrics.audioMetrics(Array(24).fill(0.00598))
  const louder = metrics.audioMetrics(Array(24).fill(0.026))
  assert.ok(quiet.energy > 0.2, 'quiet measured loopback output still moves ambient lighting')
  assert.ok(louder.energy > quiet.energy + 0.15, 'louder output retains a clear increase in light')
  assert.ok(louder.energy < 1, 'ordinary playback does not pin the ambient field at maximum')

  const once = metrics.adaptSpectrumLevels(Array(24).fill(0), Array(24).fill(1), false, 1 / 30).peaks[0]
  const half = metrics.adaptSpectrumLevels(Array(24).fill(0), Array(24).fill(1), false, 1 / 60).peaks[0]
  const twice = metrics.adaptSpectrumLevels(Array(24).fill(0), Array(24).fill(half), false, 1 / 60).peaks[0]
  assert.ok(Math.abs(once - twice) < 1e-6, 'peak release follows elapsed time rather than frame count')

  const dynamics = metrics.createAudioDynamics()
  const quietFrame = Array(24).fill(0.006)
  for (let i = 0; i < 60; i++) dynamics.update(quietFrame, true, 1 / 30)
  const settledQuiet = dynamics.update(quietFrame, true, 1 / 30)
  assert.ok(settledQuiet.energy < .5, 'makeup gain for visible geometry must not flatten the ambient light at full brightness')
  for (let i = 0; i < 60; i++) dynamics.update(Array(24).fill(.026), true, 1 / 30)
  const settledLoud = dynamics.update(Array(24).fill(.026), true, 1 / 30)
  assert.ok(settledLoud.energy > settledQuiet.energy + .2, 'the complete dynamics path preserves quiet-to-loud lighting contrast')
  assert.ok(settledLoud.energy < .8)
  dynamics.reset()
  for (let i = 0; i < 60; i++) dynamics.update(quietFrame, true, 1 / 30)
  const kick = [...Array(7).fill(0.16), ...Array(17).fill(0.006)]
  assert.ok(dynamics.update(kick, true, 1 / 30).punch > 0.2, 'bass rise produces a decaying onset pulse')
})

test('album palette extraction returns stable bounded colors from thumbnail pixels', async () => {
  const palette = await importTs('src/lib/albumPalette.ts', {})
  const colors = palette.paletteFromPixels([
    28, 55, 110, 255, 28, 55, 110, 255,
    224, 86, 72, 255, 247, 188, 96, 255,
  ])
  assert.ok(colors)
  assert.match(colors.dominant, /^#[0-9a-f]{6}$/i)
  assert.match(colors.secondary, /^#[0-9a-f]{6}$/i)
  assert.match(colors.highlight, /^#[0-9a-f]{6}$/i)
  assert.equal(palette.paletteFromPixels([0, 0, 0, 0]), null)
})

test('synthetic visualizer previews are locally labeled data and never change native capture status', async () => {
  let listener
  let status = 'error'
  const preview = await importTs('src/lib/syntheticAudioPreview.ts', {
    'solid-js': { createSignal: signal },
    '../state/audio': { AUDIO_BANDS: 24, audioCaptureStatus: () => status },
  }, {
    window: {
      location: { hostname: 'localhost' },
      addEventListener: (name, callback) => { if (name === 'hover-island:visualizer-preview') listener = callback },
    },
  })
  assert.equal(preview.syntheticAudioSpectrum(), null)
  listener({ detail: { bands: Array(24).fill(0.3) } })
  assert.equal(preview.syntheticAudioSpectrum()[0], 0.3)
  assert.equal(status, 'error')
  listener({ detail: { bands: Array(23).fill(0.8) } })
  assert.equal(preview.syntheticAudioSpectrum().length, 24, 'invalid preview payload must not replace the last valid frame')
  listener({ detail: { bands: null } })
  assert.equal(preview.syntheticAudioSpectrum(), null)
  assert.equal(status, 'error')
})

test('pending island expansion is compensated when collapse arrives before IPC resolves', async () => {
  const requests = []
  const fakeSolid = { createSignal: signal }
  const ui = await importTs('src/state/ui.ts', {
    'solid-js': fakeSolid,
    '../lib/ipc': { cmd: { setExpanded: value => {
      const request = deferred()
      requests.push({ value, ...request })
      return request.promise
    } } },
    './feedback': { reportError() {} },
  })

  ui.expandIsland()
  await until(() => requests.length === 1, 'expand command was not issued')
  assert.equal(requests[0].value, true)
  ui.collapseIsland()
  ui.finalizeCollapse()
  requests[0].resolve()
  await until(() => requests.length === 2, 'stale expand was not followed by a compensating collapse')
  assert.equal(requests[1].value, false)
  requests[1].resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(ui.expanded(), false)
  assert.equal(ui.open(), false)
  assert.equal(ui.closing(), false)
})

test('an external expand cancels a pending hover collapse', async () => {
  const requests = []
  const ui = await importTs('src/state/ui.ts', {
    'solid-js': { createSignal: signal },
    '../lib/ipc': { cmd: { setExpanded: async value => { requests.push(value) } } },
    './feedback': { reportError() {} },
  })

  ui.syncExpanded(true)
  ui.collapseIsland()
  assert.equal(ui.closing(), true)
  ui.syncExpanded(true)
  await new Promise(resolve => setTimeout(resolve, 180))
  assert.equal(ui.expanded(), true)
  assert.equal(ui.open(), true)
  assert.equal(ui.closing(), false)
  assert.deepEqual(requests, [])
})

test('a user open gesture adopts a temporary event expansion', async () => {
  const ui = await importTs('src/state/ui.ts', {
    'solid-js': { createSignal: signal },
    '../lib/ipc': { cmd: { setExpanded: async () => {} } },
    './feedback': { reportError() {} },
  })

  ui.expandIsland(true)
  assert.equal(ui.temporaryExpansion(), true)
  ui.expandIsland()
  assert.equal(ui.expanded(), true)
  assert.equal(ui.temporaryExpansion(), false)
})

function peekHarness({ initiallyOpen = false, isClosing = false, dnd = false } = {}) {
  let nextTimer = 0
  const timers = new Map()
  const timerDelays = new Map()
  let collapsed = 0
  let expanded = 0
  let temporary = false
  let panelOpen = initiallyOpen
  let timeOffset = 0
  const ClockDate = class extends Date { static now() { return Date.now() + timeOffset } }
  const settings = { dnd, notifications: { enabled: true }, modules: { notifications: true }, connections: [], dock: [], usage: { codex: true } }
  const modulePromise = importTs('src/state/peek.ts', {
    'solid-js': { createSignal: signal, untrack: fn => fn() },
    './settings': { settings },
    './ui': {
      open: () => panelOpen, closing: () => isClosing, hovering: () => false, pinned: () => false,
      temporaryExpansion: () => temporary,
      expandIsland: value => { expanded++; panelOpen = true; temporary = value },
      collapseIsland: () => { collapsed++; panelOpen = false; temporary = false },
    },
    '../lib/connectionSources': { notificationAllowed: () => true },
  }, {
    Date: ClockDate,
    setTimeout: (fn, delay = 0) => { const id = ++nextTimer; timers.set(id, fn); timerDelays.set(id, delay); return id },
    clearTimeout: id => { timers.delete(id); timerDelays.delete(id) },
  })
  return modulePromise.then(module => ({
    module, settings, timers, timerDelays,
    fireLatest() { const [id, fn] = [...timers].at(-1) ?? []; if (id !== undefined) { timers.delete(id); timerDelays.delete(id); fn() } },
    get collapsed() { return collapsed },
    get expanded() { return expanded },
    get temporary() { return temporary },
    advance(ms) { timeOffset += ms },
  }))
}

test('event peeks replace stale burst items and restart one bounded timer', async () => {
  const h = await peekHarness()
  const first = { id: 'first', app: 'WhatsApp', title: 'One', body: '', timestamp: Date.now() + 1 }
  const latest = { id: 'latest', app: 'WhatsApp', title: 'Two', body: '', timestamp: Date.now() + 2 }
  h.module.ingestNotifications([first])
  const oldTimer = [...h.timers.keys()][0]
  h.module.ingestNotifications([first, latest])
  assert.equal(h.module.peek().id, 'latest')
  assert.equal(h.timers.size, 1)
  assert.equal(h.timers.has(oldTimer), false)
  assert.equal(h.temporary, true)
  h.fireLatest()
  assert.equal(h.module.peek(), null)
  assert.equal(h.collapsed, 1)
})

test('a second event refreshes an active temporary peek without queuing old alerts', async () => {
  const h = await peekHarness()
  h.module.ingestNotifications([{ id: 'first-peek', app: 'WhatsApp', title: 'One', body: '', timestamp: Date.now() + 1 }])
  const firstTimer = [...h.timers.keys()][0]
  h.module.ingestNotifications([{ id: 'second-peek', app: 'WhatsApp', title: 'Two', body: '', timestamp: Date.now() + 2 }])
  assert.equal(h.module.peek().id, 'second-peek')
  assert.equal(h.timers.size, 1)
  assert.equal(h.timers.has(firstTimer), false)
  assert.equal(h.expanded, 2)
  h.fireLatest()
  assert.equal(h.collapsed, 1)
})

test('notification expiry leaves a user-open panel open', async () => {
  const h = await peekHarness({ initiallyOpen: true })
  h.module.ingestNotifications([{ id: 'open', app: 'WhatsApp', title: 'Hello', body: '', timestamp: Date.now() + 1 }])
  assert.equal(h.module.transientPeek(), false)
  h.fireLatest()
  assert.equal(h.module.peek(), null)
  assert.equal(h.collapsed, 0)
})

test('an event arriving while the user is closing becomes a temporary peek', async () => {
  const h = await peekHarness({ initiallyOpen: true, isClosing: true })
  h.module.ingestNotifications([{ id: 'during-close', app: 'WhatsApp', title: 'Hello', body: '', timestamp: Date.now() + 1 }])
  assert.equal(h.module.transientPeek(), true)
  h.fireLatest()
  assert.equal(h.collapsed, 1)
})

test('adopting a transient peek makes expiry preserve the panel', async () => {
  const h = await peekHarness()
  h.module.ingestNotifications([{ id: 'adopt', app: 'WhatsApp', title: 'Hello', body: '', timestamp: Date.now() + 1 }])
  h.module.promotePeek()
  h.fireLatest()
  assert.equal(h.module.peek(), null)
  assert.equal(h.collapsed, 0)
  assert.equal(h.temporary, false)
})

test('DND discards new and visible peeks', async () => {
  const h = await peekHarness()
  h.module.ingestNotifications([{ id: 'visible', app: 'WhatsApp', title: 'Hello', body: '', timestamp: Date.now() + 1 }])
  h.module.dismissPeek()
  assert.equal(h.module.peek(), null)
  assert.equal(h.collapsed, 1)
  h.settings.dnd = true
  h.module.ingestNotifications([{ id: 'muted', app: 'WhatsApp', title: 'Muted', body: '', timestamp: Date.now() + 2 }])
  assert.equal(h.module.peek(), null)
})

test('action peeks bypass app-source filters but still respect DND', async () => {
  const h = await peekHarness()
  h.module.ingestActionPeek({ id: 'focus', app: 'Focus timer', title: 'Done', body: '', timestamp: Date.now() })
  assert.equal(h.module.peek().id, 'focus')
  h.module.dismissPeek()
  h.settings.dnd = true
  h.module.ingestActionPeek({ id: 'focus-muted', app: 'Focus timer', title: 'Done', body: '', timestamp: Date.now() })
  assert.equal(h.module.peek(), null)
})

test('DND preference confirms silently while incoming alerts remain muted', async () => {
  const h = await peekHarness({ dnd: true })
  let sounds=0
  h.settings.notifications.sound='glass'
  h.module.configurePeekSound(()=>sounds++)
  h.module.ingestPreferencePeek('Do Not Disturb On','Alerts are silenced.')
  assert.equal(h.module.peek().category,'preference')
  assert.equal(sounds,0)
  h.module.ingestActionPeek({id:'muted-website',app:'Website',category:'website',title:'Muted',body:'',timestamp:Date.now()})
  assert.equal(h.module.peek().category,'preference')
  assert.equal(h.module.pendingAlert(),null)
})

test('connected alert badge expires after its collapsed peek', async () => {
  const h = await peekHarness()
  h.module.ingestActionPeek({id:'website-alert',app:'Website',category:'website',title:'Server alert',body:'',timestamp:Date.now()})
  assert.equal(h.module.pendingAlert().id,'website-alert')
  h.fireLatest()
  assert.equal(h.module.peek(),null)
  assert.equal(h.collapsed,1)
  assert.equal(h.module.pendingAlert().id,'website-alert')
  h.fireLatest()
  assert.equal(h.module.pendingAlert(),null)
})

test('verification code alerts show the code, hold a badge only until expiry, and reject stale codes', async () => {
  const h = await peekHarness()
  const expiresAt = Date.now() + 10 * 60_000
  h.module.ingestTwoFactorPeek({ id:'otp-live', code:'004291', sender:'security@example.com', subject:'Sign-in code', account:'me@example.com', receivedAt:Date.now(), expiresAt })
  assert.equal(h.module.peek().category, 'auth')
  assert.equal(h.module.peek().code, '004291')
  assert.equal(h.module.pendingAlert().code, '004291')
  assert.ok([...h.timerDelays.values()].includes(expiresAt - Date.now()) || [...h.timerDelays.values()].some(delay => delay > 9 * 60_000))
  h.module.dismissPeek()
  h.advance(expiresAt - Date.now() + 1)
  h.module.openPendingAlert()
  assert.equal(h.module.peek(), null)
  assert.equal(h.module.pendingAlert(), null)
  h.module.ingestTwoFactorPeek({ id:'otp-expired', code:'009911', sender:'security@example.com', subject:'Sign-in code', account:'me@example.com', receivedAt:Date.now(), expiresAt:Date.now() - 1 })
  assert.equal(h.module.peek(), null)
})

test('verification code alerts respect Do Not Disturb and the notifications module', async () => {
  const h = await peekHarness({ dnd:true })
  const event={id:'otp-muted',code:'220014',sender:'security@example.com',subject:'Security code',account:'me@example.com',receivedAt:Date.now(),expiresAt:Date.now()+60_000}
  h.module.ingestTwoFactorPeek(event)
  assert.equal(h.module.peek(),null)
  h.settings.dnd=false
  h.settings.modules.notifications=false
  h.module.ingestTwoFactorPeek({...event,id:'otp-module-off'})
  assert.equal(h.module.peek(),null)
})

test('completed transfer ignores late progress, keeps its collapsed alert and sounds once', async () => {
  const h = await peekHarness()
  let sounds=0
  h.settings.notifications.sound='soft'
  h.module.configurePeekSound(()=>sounds++)
  const transfer={app:'Phone bucket',category:'transfer',transferId:'bucket-1',timestamp:Date.now(),body:'photo.jpg'}
  h.module.ingestTransferPeek({...transfer,id:'progress-1',title:'Sending',phase:'sending',progress:.3})
  assert.equal(sounds,0)
  h.module.ingestTransferPeek({...transfer,id:'complete-1',title:'Sent',phase:'complete',progress:1})
  h.module.ingestTransferPeek({...transfer,id:'progress-2',title:'Sending',phase:'sending',progress:.8})
  assert.equal(h.module.peek().phase,'complete')
  assert.equal(sounds,1)
  h.fireLatest()
  assert.equal(h.module.pendingAlert().phase,'complete')
  h.module.openPendingAlert()
  assert.equal(h.module.pendingAlert(),null)
  assert.equal(sounds,1)
})

test('spring reversals preserve current velocity and settle at their new target', async () => {
  const { stepSpring } = await importTs('src/state/motion.ts', {})
  let state = { value: 0, velocity: 0 }
  for (let i = 0; i < 12; i++) state = stepSpring(state, 100, 1 / 60)
  assert.ok(state.velocity > 0)
  const beforeReverse = state
  state = stepSpring(state, 0, 0.001)
  assert.ok(state.value > beforeReverse.value, 'velocity should continue smoothly through the reversal')
  for (let i = 0; i < 180; i++) state = stepSpring(state, 0, 1 / 60)
  assert.equal(state.value, 0)
  assert.equal(state.velocity, 0)
})

test('magnetic offsets stay small, reverse with retained velocity, and respect reduced motion', async () => {
  const { clampMagneticOffset, stepMagneticOffset } = await importTs('src/state/motion.ts', {})
  const bounded = clampMagneticOffset({ x: 100, y: -100 })
  assert.equal(bounded.x, 6)
  assert.equal(bounded.y, -6)
  const invalid = clampMagneticOffset({ x: Number.NaN, y: Number.POSITIVE_INFINITY })
  assert.equal(invalid.x, 0)
  assert.equal(invalid.y, 0)
  let state = { x: { value: 0, velocity: 0 }, y: { value: 0, velocity: 0 } }
  for (let i = 0; i < 8; i++) state = stepMagneticOffset(state, { x: 5, y: -4 }, 1 / 60)
  assert.ok(state.x.velocity > 0 && state.y.velocity < 0)
  const beforeReverse = state
  state = stepMagneticOffset(state, { x: -5, y: 4 }, 0.001)
  assert.ok(state.x.value > beforeReverse.x.value && state.y.value < beforeReverse.y.value)
  const reduced = stepMagneticOffset(state, { x: 6, y: 6 }, 1 / 60, true)
  assert.equal(reduced.x.value, 0)
  assert.equal(reduced.x.velocity, 0)
  assert.equal(reduced.y.value, 0)
  assert.equal(reduced.y.velocity, 0)
})

test('media track changes are silent at startup and only announce a new playing track', async () => {
  let changed
  const alerts = []
  const media = await importTs('src/state/media.ts', {
    'solid-js': { createSignal: signal },
    '../lib/ipc': {
      cmd: { mediaGet: async () => ({ title: 'Startup track', artist: 'Artist', status: 'playing' }) },
      onMediaChanged: async callback => { changed = callback; return () => {} },
    },
    './feedback': { reportError() {} },
  })
  const cleanup = await media.subscribeMedia(item => alerts.push(item.title))
  assert.deepEqual(alerts, [])
  changed({ title: 'Startup track', artist: 'Artist', status: 'playing' })
  changed({ title: 'Startup track', artist: 'Artist', status: 'paused' })
  changed({ title: 'Next track', artist: 'Artist', status: 'playing' })
  assert.deepEqual(alerts, ['Next track'])
  cleanup()
})

const defaults = {
  panels: { today: 'Today', desk: 'Desk', activity: 'Activity' }, panelOrder: ['today', 'desk', 'activity'], widgets: [],
  version: 1, hotkey: 'Alt+Space', launchAtLogin: false,
  collapsed: { w: 320, h: 42 }, expanded: { w: 700, h: 500 },
  opacity: 0.9, accent: '#6e8bff', theme: 'default',
  modules: { media: true, visualizer: true, notifications: true, usage: true, dock: true },
  visualizer: { style: 'orb', intensity: 0.5, reactivity: 0.5 }, dock: [],
  usage: { codex: true, claudeCode: false, cursor: false, manual: false,
    manualConfig: { label: 'Custom', used: null, limit: null, unit: 'tokens', resetAt: null } },
  notifications: { enabled: true, systemListener: false },
  interaction: { hoverOpen: true, openDelayMs: 140, closeDelayMs: 450 },
}

test('reset watcher establishes a quiet baseline, alerts for new fresh posts, and suppresses stale-source alerts', async () => {
  const alerts = []
  const values = new Map()
  let response = { events: [{ id: 'old', kind: 'global', title: 'Prior reset' }], stale: false, lastCheckedAt: Date.now(), source: 'tracker' }
  const module = await importTs('src/state/resetWatch.ts', {
    'solid-js': { createSignal: signal },
    '../lib/ipc': { cmd: { resetWatch: async () => response } },
    './settings': { settings: { modules: { usage: true }, usage: { codex: true } } },
    './peek': { ingestNotifications: items => alerts.push(...items) },
  }, { localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) } })
  await module.refreshResetWatch()
  assert.equal(alerts.length, 0)
  response = { ...response, events: [...response.events, { id: 'new', kind: 'banked', title: 'Banked grant announced' }] }
  await module.refreshResetWatch()
  assert.equal(alerts.length, 1)
  assert.match(alerts[0].title, /Banked/)
  response = { ...response, stale: true, events: [...response.events, { id: 'stale', kind: 'global', title: 'Old source update' }] }
  await module.refreshResetWatch()
  assert.equal(alerts.length, 1)
  assert.equal(module.resetSnapshot().stale, true)
})

function settingsMocks(getPromise, calls, eventHandlers = [], options = {}) {
  let persisted = structuredClone(defaults)
  return {
    'solid-js': {
      createEffect: effect => effect(),
      createSignal: signal,
    },
    'solid-js/store': {
      createStore(initial) {
        let current = initial
        const store = new Proxy({}, {
          get: (_, key) => current[key],
          ownKeys: () => Reflect.ownKeys(current),
          getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
        })
        return [store, next => { current = typeof next === 'function' ? next(current) : next }]
      },
      reconcile: value => value,
      unwrap: value => JSON.parse(JSON.stringify(value)),
    },
    '../lib/ipc': {
      cmd: {
        settingsGet: () => getPromise,
        settingsSet: async patch => {
          calls.push(patch)
          if (options.failWrites) throw new Error('simulated write failure')
          persisted = mergeSettings(persisted, patch)
          const result = structuredClone(persisted)
          if (options.emitWriteEvents) eventHandlers.forEach(handler => handler(result))
          if (options.writeGate) await options.writeGate.promise
          return result
        },
        settingsReset: async () => { persisted = structuredClone(defaults); return structuredClone(persisted) },
      },
      DEFAULT_SETTINGS: structuredClone(defaults),
      onSettingsChanged: callback => {
        eventHandlers.push(value => {
          persisted = structuredClone(value)
          callback(value)
        })
        return Promise.resolve(() => {})
      },
    },
    '../lib/themes': { applyTemplate() {} },
    './ui': { applyAccent() {} },
    './feedback': { reportError() {} },
  }
}

function mergeSettings(base, patch) {
  return {
    ...base, ...patch,
    collapsed: { ...base.collapsed, ...patch.collapsed },
    expanded: { ...base.expanded, ...patch.expanded },
    modules: { ...base.modules, ...patch.modules },
    visualizer: { ...base.visualizer, ...patch.visualizer },
    notifications: { ...base.notifications, ...patch.notifications },
    interaction: { ...base.interaction, ...patch.interaction },
    usage: { ...base.usage, ...patch.usage,
      manualConfig: { ...base.usage.manualConfig, ...patch.usage?.manualConfig } },
  }
}

test('late startup settings read does not erase a local edit', async () => {
  const read = deferred()
  const writes = []
  const module = await importTs('src/state/settings.ts', settingsMocks(read.promise, writes), {
    document: { documentElement: { style: { setProperty() {} } } },
  })
  const loading = module.loadSettings()
  module.patchSettings({ accent: '#ff5500' })
  read.resolve({ ...structuredClone(defaults), accent: '#223344' })
  await loading
  assert.equal(module.settings.accent, '#ff5500')
  await module.flushSettings()
  assert.equal(module.settings.accent, '#ff5500')
  assert.equal(writes.at(-1).accent, '#ff5500')
})

test('settings flush coalesces edits and waits for their writes', async () => {
  const writes = []
  const module = await importTs('src/state/settings.ts', settingsMocks(Promise.resolve(structuredClone(defaults)), writes), {
    document: { documentElement: { style: { setProperty() {} } } },
  })
  await module.loadSettings()
  module.patchSettings({ opacity: 0.7 })
  module.patchSettings({ hotkey: 'Ctrl+Alt+Space' })
  await module.flushSettings()
  assert.equal(writes.length, 1)
  assert.deepEqual({ opacity: writes[0].opacity, hotkey: writes[0].hotkey }, {
    opacity: 0.7, hotkey: 'Ctrl+Alt+Space',
  })
  assert.equal(module.savingSettings(), false)
})

test('new cross-window settings beat stale startup reads and preserve local pending edits', async () => {
  const read = deferred()
  const writes = []
  const events = []
  const module = await importTs('src/state/settings.ts', settingsMocks(read.promise, writes, events), {
    document: { documentElement: { style: { setProperty() {} } } },
  })
  const loading = module.loadSettings()
  await until(() => events.length === 1, 'settings event subscription was not installed')
  events[0]({ ...structuredClone(defaults), accent: '#123456', weatherCity: 'Paris' })
  module.patchSettings({ opacity: 0.7 })
  events[0]({ ...structuredClone(defaults), accent: '#654321', opacity: 0.5, weatherCity: 'Tokyo' })
  assert.equal(module.settings.accent, '#654321')
  assert.equal(module.settings.weatherCity, 'Tokyo')
  assert.equal(module.settings.opacity, 0.7)
  read.resolve({ ...structuredClone(defaults), accent: '#223344', weatherCity: 'London' })
  await loading
  assert.equal(module.settings.accent, '#654321')
  assert.equal(module.settings.weatherCity, 'Tokyo')
  assert.equal(module.settings.opacity, 0.7)
  await module.flushSettings()
  assert.equal(module.settings.accent, '#654321')
  assert.equal(module.settings.weatherCity, 'Tokyo')
})

test('failed local save rolls back to the newest cross-window settings snapshot', async () => {
  const read = deferred()
  const events = []
  const options = { failWrites: true }
  const module = await importTs('src/state/settings.ts', settingsMocks(read.promise, [], events, options), {
    document: { documentElement: { style: { setProperty() {} } } },
  })
  const loading = module.loadSettings()
  await until(() => events.length === 1, 'settings event subscription was not installed')
  events[0]({ ...structuredClone(defaults), accent: '#123456', weatherCity: 'Paris', opacity: 0.6 })
  module.patchSettings({ opacity: 0.7 })
  read.resolve({ ...structuredClone(defaults), accent: '#223344', weatherCity: 'London' })
  await loading
  await assert.rejects(module.flushSettings(), /simulated write failure/)
  assert.equal(module.settings.accent, '#123456')
  assert.equal(module.settings.weatherCity, 'Paris')
  assert.equal(module.settings.opacity, 0.6)
})

test('settings flush rejects a failed save and keeps it retryable', async () => {
  const options = { failWrites: true }
  const writes = []
  const module = await importTs('src/state/settings.ts', settingsMocks(
    Promise.resolve(structuredClone(defaults)), writes, [], options,
  ), {
    document: { documentElement: { style: { setProperty() {} } } },
  })
  await module.loadSettings()
  module.patchSettings({ opacity: 0.72 })
  await assert.rejects(module.flushSettings(), /simulated write failure/)
  assert.equal(writes.length, 1)

  options.failWrites = false
  await module.flushSettings()
  assert.equal(writes.length, 2)
  assert.equal(writes[1].opacity, 0.72)
  assert.equal(module.settings.opacity, 0.72)
})

test('late settings IPC response cannot replace a newer cross-window snapshot', async () => {
  const writes = []
  const events = []
  const gate = deferred()
  const module = await importTs('src/state/settings.ts', settingsMocks(
    Promise.resolve(structuredClone(defaults)), writes, events,
    { emitWriteEvents: true, writeGate: gate },
  ), {
    document: { documentElement: { style: { setProperty() {} } } },
  })
  await module.loadSettings()
  module.patchSettings({ opacity: 0.7 })
  const flushing = module.flushSettings()
  await until(() => writes.length === 1, 'settings write did not start')
  events[0]({ ...structuredClone(defaults), accent: '#aabbcc', opacity: 0.4 })
  gate.resolve()
  await flushing
  assert.equal(module.settings.accent, '#aabbcc')
  assert.equal(module.settings.opacity, 0.4)
})

test('focus state rejects malformed storage and ignores non-finite durations', async () => {
  const values = new Map([['hover-island.focus.v1', JSON.stringify({
    duration: 1500, remaining: 800, endsAt: null, completed: 'yes',
  })]])
  const focus = await importTs('src/state/focus.ts', {
    'solid-js': { createSignal: signal },
  }, {
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
  })
  assert.deepEqual(JSON.parse(JSON.stringify(focus.focusTimer())), {
    duration: 1500, remaining: 1500, endsAt: null, completed: false,
  })
  focus.resetFocus(Number.NaN)
  assert.equal(focus.focusTimer().duration, 1500)
  focus.resetFocus(181)
  assert.equal(focus.focusTimer().duration, 10_800)
})
