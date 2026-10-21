import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

test('palette caching retains at most 2 MiB of image keys and skips oversized artwork', async () => {
  const source = await readFile(new URL('../src/lib/albumPalette.ts', import.meta.url), 'utf8')
  let decoded = 0
  let released = 0
  class Image {
    set src(value) { decoded++; queueMicrotask(() => this.onload()) }
    removeAttribute(name) { if (name === 'src') released++ }
  }
  const exported = {}
  vm.runInNewContext(ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText, {
    exports:exported,module:{exports:exported},Image,
    document:{createElement:()=>({getContext:()=>({drawImage(){},getImageData:()=>({data:[40,90,140,255]})})})},
  })
  await exported.getAlbumPalette('small-image')
  await exported.getAlbumPalette('small-image')
  assert.equal(decoded,1,'a small key reuses its palette')
  exported.clearAlbumPaletteCache()
  const first='A'.repeat(600000), second='B'.repeat(600000)
  await exported.getAlbumPalette(first)
  await exported.getAlbumPalette(second)
  await exported.getAlbumPalette(first)
  assert.equal(decoded,4,'byte budget evicts old keys even below the count limit')
  const oversized='C'.repeat(1048577)
  await exported.getAlbumPalette(oversized)
  await exported.getAlbumPalette(oversized)
  assert.equal(decoded,6,'oversized image keys are never retained')
  assert.equal(released,decoded,'decoded image resources are detached after palette extraction')
})

