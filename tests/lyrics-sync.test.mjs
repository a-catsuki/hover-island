import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

async function load() {
  const source = await readFile(new URL('../src/lib/lyricsSync.ts', import.meta.url), 'utf8')
  const exported = {}
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: exported, module: { exports: exported } })
  return exported
}

test('LRC parser handles stamps, fractions, offsets, word tags and gaps', async () => {
  const { parseLrc } = await load()
  const lines = parseLrc('[ti:Song]\n[offset:500]\n[00:02.00][00:01.00]Chorus\n[00:01.00]Chorus\n[00:03.5]\n[00:04:25]<00:04.25>Hello <00:05.00>world\n[00:05.123]Millis\n[99:00.00]Outside', 10)
  assert.deepEqual(Array.from(lines.map(l => l.text)), ['Chorus', 'Chorus', '', 'Hello world', 'Millis'])
  assert.deepEqual(Array.from(lines.map(l => +l.at.toFixed(3))), [0.5, 1.5, 3, 3.75, 4.623])
  assert.equal(parseLrc('[00:NaN]x\n[ar:A]\nplain').length, 0)
  assert.equal(parseLrc('[00:05.00]\n[00:06.00]a\n[00:07.00]\n[00:08.00]\n')[1].text, '')
  assert.equal(parseLrc('[00:05.00]\n[00:06.00]a')[0].text, 'a', 'leading gaps are dropped')
})

test('current line lookup uses the lead and clamps before the first line', async () => {
  const { activeLineIndex, untimedLineIndex, LYRICS_LEAD_SECONDS } = await load()
  const lines = [{ at: 1 }, { at: 5 }, { at: 9 }]
  assert.equal(LYRICS_LEAD_SECONDS, 0.25)
  assert.equal(activeLineIndex(lines, 0), -1)
  assert.equal(activeLineIndex(lines, 0.74), -1)
  assert.equal(activeLineIndex(lines, 0.76), 0, 'lead switches slightly early')
  assert.equal(activeLineIndex(lines, 4.7), 0)
  assert.equal(activeLineIndex(lines, 4.8), 1)
  assert.equal(activeLineIndex(lines, 999), 2)
  assert.equal(activeLineIndex([], 3), -1)
  assert.equal(activeLineIndex(lines, NaN), -1)
  assert.equal(activeLineIndex(lines, 5, 0), 1)
  assert.equal(untimedLineIndex(10, 50, 100), 5)
  assert.equal(untimedLineIndex(10, 500, 100), 9)
  assert.equal(untimedLineIndex(10, 5, 0), 0)
})

test('lyrics track key changes with the track and rejects unusable metadata', async () => {
  const { lyricsTrackKey } = await load()
  const a = lyricsTrackKey({ title: 'Closer', artist: 'Chainsmokers', album: 'x', duration: 244.2 })
  assert.ok(a)
  assert.notEqual(a, lyricsTrackKey({ title: 'Closer', artist: 'Chainsmokers', album: 'x', duration: 300 }))
  assert.equal(lyricsTrackKey({ title: ' ', artist: 'A', duration: 100 }), null)
  assert.ok(lyricsTrackKey({ title: 'T', artist: 'A', duration: 0 }), 'no length still matches by name')
  assert.equal(lyricsTrackKey(null), null)
})
