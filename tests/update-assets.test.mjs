import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, unlink, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { ensureUpdateAssets } from '../marketing/scripts/ensure-update-assets.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hover-update-assets-test-'))
  const updates = join(root, 'updates')
  await mkdir(updates)
  t.after(async () => {
    for (const name of ['latest.json', 'HoverIsland-0.1.12.msix', 'Publisher.cer']) {
      try { await unlink(join(updates, name)) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    await rmdir(updates); await rmdir(root)
  })
  const packageBytes = Buffer.from('signed package fixture')
  const certificateBytes = Buffer.from('public certificate fixture')
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  const manifest = { version: '0.1.12', url: 'https://hover-island.vercel.app/updates/HoverIsland-0.1.12.msix', sha256: hash(packageBytes), certificateSha256: hash(certificateBytes) }
  await writeFile(join(updates,'latest.json'), JSON.stringify(manifest))
  return { root, updates, manifest, packageBytes, certificateBytes }
}

test('a Git checkout restores ignored update assets and an offline staged build retains them', async t => {
  const f = await fixture(t)
  const requests = []
  const fetcher = async url => {
    requests.push(url)
    return new Response(url.endsWith('.msix') ? f.packageBytes : f.certificateBytes)
  }
  await ensureUpdateAssets(f.root, fetcher)
  assert.equal(requests.length,2)
  assert.deepEqual(await readFile(join(f.updates,'HoverIsland-0.1.12.msix')),f.packageBytes)
  assert.deepEqual(await readFile(join(f.updates,'Publisher.cer')),f.certificateBytes)
  await ensureUpdateAssets(f.root, () => { throw new Error('offline build must use its verified local assets') })
})

test('a missing or corrupted published installer blocks the site build', async t => {
  const f = await fixture(t)
  await assert.rejects(ensureUpdateAssets(f.root, async () => new Response('missing',{status:404})), /unavailable: HTTP 404/)
  await assert.rejects(ensureUpdateAssets(f.root, async () => new Response('corrupted package')), /SHA-256 mismatch/)
  await assert.rejects(readFile(join(f.updates,'HoverIsland-0.1.12.msix')), { code: 'ENOENT' })
})
