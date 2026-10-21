import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/lib/weatherLayout.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
const layoutModule = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
const { weatherLayout, canLoadWeather, createWeatherLoader } = layoutModule

test('weather shows only the data that fits the actual tile and expands in detail mode', () => {
  assert.equal(weatherLayout(280, 164), 'compact')
  assert.equal(weatherLayout(580, 164), 'wide')
  assert.equal(weatherLayout(280, 320), 'tall')
  assert.equal(weatherLayout(342, 450), 'tall')
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

test('browser preview can show the denied state: a structured failure with a settings action', async () => {
  const previewSource = await readFile(new URL('../src/lib/preview.ts', import.meta.url), 'utf8')
  const previewJs = ts.transpileModule(previewSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  const { previewInvoke } = await import(`data:text/javascript;base64,${Buffer.from(previewJs).toString('base64')}`)
  globalThis.localStorage = { getItem: key => key === 'hover-island.preview.weather-detect' ? JSON.stringify('denied') : null, setItem() {}, removeItem() {} }
  try {
    await assert.rejects(previewInvoke('weather_detect_location', {}, {}), error => error.code === 'windows_disabled' && error.canOpenSettings === true && /Turn it on/.test(error.message))
  } finally {
    delete globalThis.localStorage
  }
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

test('weather orientations list every shape with a layout and a grid footprint', () => {
  const { WEATHER_ORIENTATIONS, weatherOrientation, weatherOrientationFor, weatherVerticalHourCount } = layoutModule
  assert.deepEqual(WEATHER_ORIENTATIONS.map(item => item.id), ['compact', 'wide', 'vertical', 'large'])
  for (const item of WEATHER_ORIENTATIONS) {
    assert.ok(item.label && item.hint)
    assert.ok([1, 2].includes(item.columns) && [1, 2].includes(item.rows))
  }
  assert.equal(weatherOrientation('vertical').layout, 'tall')
  assert.equal(weatherOrientation('nope'), undefined)
  assert.equal(weatherOrientationFor(1, 1).id, 'compact')
  assert.equal(weatherOrientationFor(2, 1).id, 'wide')
  assert.equal(weatherOrientationFor(1, 2).id, 'vertical')
  assert.equal(weatherOrientationFor(2, 2).id, 'large')
  // Each orientation's footprint produces the layout it advertises at typical tile sizes.
  const sizes = { compact: [342, 201], wide: [700, 201], vertical: [342, 440], large: [700, 440] }
  for (const item of WEATHER_ORIENTATIONS) assert.equal(weatherLayout(...sizes[item.id]), item.layout)
  assert.ok(weatherVerticalHourCount(440, 2) >= 3)
  assert.ok(weatherVerticalHourCount(440, 1) > weatherVerticalHourCount(440, 2))
  assert.equal(weatherVerticalHourCount(100, 2), 0)
  assert.equal(weatherVerticalHourCount(0), 4)
})

test('location failures from Windows, the old string form and garbage all become actionable messages', () => {
  const { normalizeLocationFailure } = layoutModule
  const denied = normalizeLocationFailure({ code: 'windows_disabled', message: 'Location is turned off in Windows. Turn it on, or pick a city.', canOpenSettings: true })
  assert.equal(denied.canOpenSettings, true)
  assert.equal(normalizeLocationFailure({ code: 'windows_disabled', message: 'x' }).canOpenSettings, true)
  assert.equal(normalizeLocationFailure({ code: 'offline', message: 'No internet connection.' }).canOpenSettings, false)
  assert.deepEqual(normalizeLocationFailure('Error: Something broke'), { code: 'unavailable', message: 'Something broke', canOpenSettings: false })
  assert.match(normalizeLocationFailure(null).message, /Pick a city/)
  assert.match(normalizeLocationFailure({ message: '  ' }).message, /Pick a city/)
})

test('device location is re-checked quietly only for people who opted in, and only every few hours', () => {
  const { shouldRecheckDeviceLocation, movedFar, normalizeUnits, DEVICE_RECHECK_MS } = layoutModule
  const now = 10 * DEVICE_RECHECK_MS
  assert.equal(shouldRecheckDeviceLocation(false, null, now), false)
  assert.equal(shouldRecheckDeviceLocation(true, null, now), true)
  assert.equal(shouldRecheckDeviceLocation(true, now - 1000, now), false)
  assert.equal(shouldRecheckDeviceLocation(true, now - DEVICE_RECHECK_MS, now), true)
  assert.equal(movedFar({ lat: -37.81, lon: 144.96 }, { latitude: -37.8, longitude: 144.97 }), false)
  assert.equal(movedFar({ lat: -37.81, lon: 144.96 }, { latitude: -33.87, longitude: 151.21 }), true)
  assert.equal(movedFar({}, { latitude: 1, longitude: 1 }), true)
  assert.equal(normalizeUnits('imperial'), 'imperial')
  assert.equal(normalizeUnits('kelvin'), 'metric')
  assert.equal(normalizeUnits(undefined), 'metric')
})
