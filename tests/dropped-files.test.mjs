import assert from 'node:assert/strict'
import { File } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

async function loadDroppedFiles() {
  const source = await readFile(new URL('../src/lib/droppedFiles.ts', import.meta.url), 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const exported = {}
  const context = vm.createContext({ exports: exported, module: { exports: exported }, File, TextEncoder })
  vm.runInContext(js, context, { filename: 'droppedFiles.ts' })
  return context.module.exports
}

test('folder selection produces a path-preserving bounded ZIP', async () => {
  const { filesFromPicker } = await loadDroppedFiles()
  const first = new File(['hello'], 'hello.txt')
  Object.defineProperty(first, 'webkitRelativePath', { value: 'Project/src/hello.txt' })
  const second = new File(['world'], 'world.txt')
  Object.defineProperty(second, 'webkitRelativePath', { value: 'Project/docs/world.txt' })
  const [archive] = await filesFromPicker([first, second])
  assert.equal(archive.name, 'Project.zip')
  assert.equal(archive.type, 'application/zip')
  const bytes = new Uint8Array(await archive.arrayBuffer())
  const text = new TextDecoder().decode(bytes)
  assert.match(text, /src\/hello\.txt/)
  assert.match(text, /docs\/world\.txt/)
  assert.match(text, /hello/)
  assert.match(text, /world/)
  assert.equal(new DataView(bytes.buffer).getUint32(bytes.length - 22, true), 0x06054b50)
})

test('folder archives reject path traversal and source larger than 95 MB', async () => {
  const { filesFromPicker } = await loadDroppedFiles()
  const traversal = new File(['x'], 'escape.txt')
  Object.defineProperty(traversal, 'webkitRelativePath', { value: 'Project/../escape.txt' })
  await assert.rejects(filesFromPicker([traversal]), /unsafe relative path/)

  const large = { name: 'large.bin', size: 95 * 1024 * 1024 + 1, webkitRelativePath: 'Project/large.bin' }
  await assert.rejects(filesFromPicker([large]), /95 MB/)
})

test('dragged folders are traversed into one archive without altering loose files', async () => {
  const { filesFromDrop } = await loadDroppedFiles()
  const loose = new File(['loose'], 'loose.txt')
  const nested = new File(['nested'], 'inside.txt')
  const fileEntry = (file) => ({
    name: file.name,
    isFile: true,
    isDirectory: false,
    file: success => success(file),
  })
  const folder = {
    name: 'Photos',
    isFile: false,
    isDirectory: true,
    createReader: () => {
      let returned = false
      return { readEntries: success => { const batch = returned ? [] : [fileEntry(nested)]; returned = true; success(batch) } }
    },
  }
  const dataTransfer = {
    items: [{ webkitGetAsEntry: () => folder }, { webkitGetAsEntry: () => fileEntry(loose) }],
    files: [loose],
  }
  const result = await filesFromDrop(dataTransfer)
  assert.equal(result.length, 2)
  assert.equal(result[0], loose)
  assert.equal(result[1].name, 'Photos.zip')
  assert.match(new TextDecoder().decode(await result[1].arrayBuffer()), /inside\.txt/)
})

test('dragged folder traversal stops at 500 files without launching parallel reads', async () => {
  const { filesFromDrop } = await loadDroppedFiles()
  const folderEntry = (name, count, reads) => {
    let returned = false
    const children = Array.from({ length: count }, (_, index) => ({
      name: `${name}-${index}.txt`, isFile: true, isDirectory: false,
      file: success => { reads.count++; success(new File(['x'], `${name}-${index}.txt`)) },
    }))
    return {
      name, isFile: false, isDirectory: true,
      createReader: () => ({ readEntries: success => { const batch = returned ? [] : children; returned = true; success(batch) } }),
    }
  }
  const reads = { count: 0 }
  let rootReturned = false
  const folder = {
    name: 'Many', isFile: false, isDirectory: true,
    createReader: () => ({ readEntries: success => {
      const batch = rootReturned ? [] : [folderEntry('First', 300, reads), folderEntry('Second', 300, reads)]
      rootReturned = true
      success(batch)
    } }),
  }
  await assert.rejects(filesFromDrop({
    items: [{ webkitGetAsEntry: () => folder }], files: [],
  }), /at most 500 files/)
  assert.equal(reads.count, 500)
})
