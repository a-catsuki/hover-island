import { createHash } from 'node:crypto'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const paths = []
async function collect(path) {
  let info
  try { info = await stat(path) } catch (error) { if (error.code === 'ENOENT') return; throw error }
  if (info.isDirectory()) {
    for (const name of (await readdir(path)).sort()) await collect(resolve(path, name))
  } else if (info.isFile()) paths.push(path)
}
for (const path of ['src', 'src-tauri/src', 'src-tauri/capabilities', 'src-tauri/icons', 'packaging/windows',
  'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'index.html', 'settings.html',
  'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/build.rs', 'src-tauri/tauri.conf.json']) {
  await collect(resolve(root, path))
}
const files = []
for (const path of paths.sort()) {
  const bytes = await readFile(path)
  files.push({ path: relative(root, path).replaceAll('\\', '/'), bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') })
}
const fingerprint = createHash('sha256').update(JSON.stringify(files)).digest('hex')
const output = resolve(root, process.argv[2] ?? 'docs/verification/release-source-before.json')
if (!output.startsWith(resolve(root, 'docs/verification') + '\\') && !output.startsWith(resolve(root, 'docs/verification') + '/')) {
  throw new Error('Release evidence must stay in docs/verification')
}
await writeFile(output, JSON.stringify({ recordedAt: new Date().toISOString(), fingerprint, fileCount: files.length, files }, null, 2) + '\n')
console.log(JSON.stringify({ fingerprint, fileCount: files.length, output }))
