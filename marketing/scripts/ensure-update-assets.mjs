// Git excludes installers. Restore the exact published assets before a Git site deployment.
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const origin = 'https://hover-island.vercel.app'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

export async function ensureUpdateAssets(siteRoot, fetcher = fetch) {
  const updates = join(siteRoot, 'updates')
  const manifest = JSON.parse(await readFile(join(updates, 'latest.json'), 'utf8'))
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Invalid update version')
  const packageName = `HoverIsland-${manifest.version}.msix`
  if (manifest.url !== `${origin}/updates/${packageName}`) throw new Error('Unexpected update source')
  const assets = [
    { name: packageName, hash: manifest.sha256 },
    { name: 'Publisher.cer', hash: manifest.certificateSha256 },
  ]
  for (const asset of assets) {
    if (!/^[a-f0-9]{64}$/.test(asset.hash ?? '')) throw new Error(`Missing SHA-256 for ${asset.name}`)
    const path = join(updates, asset.name)
    let bytes
    try { bytes = await readFile(path) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (!bytes) {
      const response = await fetcher(`${origin}/updates/${asset.name}`, { signal: AbortSignal.timeout(60000), redirect: 'error' })
      if (!response.ok) throw new Error(`Published ${asset.name} is unavailable: HTTP ${response.status}`)
      bytes = Buffer.from(await response.arrayBuffer())
    }
    if (sha256(bytes) !== asset.hash) throw new Error(`SHA-256 mismatch for ${asset.name}`)
    await writeFile(path, bytes)
  }
  return assets.map(asset => asset.name)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const assets = await ensureUpdateAssets(dirname(dirname(fileURLToPath(import.meta.url))))
  console.log(`Verified update assets: ${assets.join(', ')}`)
}
