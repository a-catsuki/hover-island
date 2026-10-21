import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const load = async name => {
  let src = await readFile(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8')
  src = src.replace(/^import .*$/gm, '').replace(/^export type .*$/gm, '')
  return ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
}
const { uniqueApps, sectionLetter, filterApps, groupByLetter, appSlug } = await import(`data:text/javascript;base64,${Buffer.from((await load('nativeApps')).replace(/\b(matchingConnection|sourceMatches)\b/g, m => m === 'sourceMatches' ? '(()=>false)' : '(()=>undefined)')).toString('base64')}`)

test('app list is unique, sorted and skips url shortcuts', () => {
  const list = uniqueApps([{ id: '1', name: 'Zoom' }, { id: '2', name: 'discord' }, { id: '3', name: 'Discord' }, { id: '4', name: 'Site', kind: 'url' }])
  assert.deepEqual(list.map(a => a.id), ['2', '1'])
})
test('sections and search', () => {
  assert.equal(sectionLetter('Éclair'), 'E')
  assert.equal(sectionLetter('7-Zip'), '#')
  const apps = [{ id: 'a', name: 'Notepad' }, { id: 'b', name: 'Windows Notes' }, { id: 'c', name: 'Note' }]
  assert.deepEqual(filterApps(apps, 'note').map(a => a.id), ['a', 'c', 'b'])
  assert.deepEqual(groupByLetter(uniqueApps(apps)).map(s => s.letter), ['N', 'W'])
  assert.equal(appSlug('Visual Studio Code'), 'visual-studio-code')
})
