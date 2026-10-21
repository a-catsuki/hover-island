import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/lib/weatherLayout.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
const { weatherLayout, canLoadWeather, createWeatherLoader } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

test('weather shows only the data that fits the actual tile and expands in detail mode', () => {
  assert.equal(weatherLayout(280, 164), 'compact')
  assert.equal(weatherLayout(580, 164), 'wide')
  assert.equal(weatherLayout(280, 320), 'full')
  assert.equal(weatherLayout(580, 320), 'full')
})

test('weather requires saved valid coordinates; an old automatic-location flag cannot trigger lookup', () => {
  assert.equal(canLoadWeather({}), false)
  assert.equal(canLoadWeather({ weatherAutoLocation: false }), false)
  assert.equal(canLoadWeather({ weatherAutoLocation: true }), false)
  assert.equal(canLoadWeather({ weatherLat: 0, weatherLon: 0, weatherCity: 'Null Island' }), true)
  assert.equal(canLoadWeather({ weatherLat: 91, weatherLon: 0, weatherCity: 'Invalid' }), false)
  assert.equal(canLoadWeather({ weatherLat: 28.6, weatherLon: null, weatherCity: 'Delhi' }), false)
  assert.equal(canLoadWeather({ weatherLat: 28.6, weatherLon: 77.2, weatherCity: ' ' }), false)
})

test('browser preview declines device location instead of inventing a consented position', async () => {
  const previewSource = await readFile(new URL('../src/lib/preview.ts', import.meta.url), 'utf8')
  const previewJs = ts.transpileModule(previewSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  const { previewInvoke } = await import(`data:text/javascript;base64,${Buffer.from(previewJs).toString('base64')}`)
  await assert.rejects(previewInvoke('weather_detect_location', {}, {}), /Windows app.*Choose a city/)
})

test('compact weather drops old-city replies and clearing location stops future requests', async () => {
  let snapshot = 'old city'
  const requests = []
  const loader = createWeatherLoader(() => new Promise((resolve, reject) => requests.push({ resolve, reject })), value => { snapshot = value })
  await loader.refresh()
  assert.equal(requests.length, 0)
  loader.configure(true)
  assert.equal(snapshot, null)
  const first = loader.refresh()
  loader.configure(true) // Another city replaces the original selection.
  const second = loader.refresh()
  requests[0].resolve('previous city')
  await first
  assert.equal(snapshot, null)
  requests[1].resolve('selected city')
  await second
  assert.equal(snapshot, 'selected city')
  const pending = loader.refresh()
  loader.configure(false) // Consent or the saved location was cleared.
  requests[2].resolve('late selected city')
  await pending
  await loader.refresh()
  assert.equal(snapshot, null)
  assert.equal(requests.length, 3)
  loader.configure(true)
  const failed = loader.refresh()
  requests[3].reject(new Error('Unavailable'))
  await failed
  assert.equal(snapshot, null)
})

test('weather splits current conditions and forecast only when the tile is tall and wide', async () => {
  const { weatherSplit, weatherHourCount } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
  assert.equal(weatherSplit(732, 450), true)
  assert.equal(weatherSplit(342, 450), false)
  assert.equal(weatherSplit(732, 201), false)
  assert.equal(weatherHourCount(342), 6)
  assert.equal(weatherHourCount(120), 3)
  assert.equal(weatherHourCount(4000), 24)
  assert.equal(weatherHourCount(0), 5)
})
