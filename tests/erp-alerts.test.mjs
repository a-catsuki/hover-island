import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/lib/erpAlerts.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText.replace("import type { ErpAlert } from './erpIpc';", '')
const erp = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

const alert = (id, timestamp, priority = 'high') => ({
  id, app: 'Store Inventory ERP', title: 'Approval needed', body: 'Review PO 10',
  timestamp, priority, url: '/purchase-orders/PO-10',
})

test('website alert ordering and update identity distinguish revisions without repeated poll churn', () => {
  const newer = alert('po:10', 200)
  const older = alert('pi:3', 100, 'urgent')
  assert.deepEqual(erp.sortErpAlerts([older, newer]), [newer, older])
  assert.equal(erp.erpAlertUpdateKey(newer), erp.erpAlertUpdateKey({ ...newer }))
  assert.notEqual(erp.erpAlertUpdateKey(newer), erp.erpAlertUpdateKey({ ...newer, timestamp: 201 }))
  assert.notEqual(erp.erpAlertUpdateKey(newer), erp.erpAlertUpdateKey({ ...newer, body: 'Updated' }))
})

test('website alert links stay on the paired origin and require HTTPS except localhost development', () => {
  assert.equal(erp.safeErpAlertUrl('/purchase-orders/PO%201', 'https://erp.example.com'), 'https://erp.example.com/purchase-orders/PO%201')
  assert.equal(erp.safeErpAlertUrl('https://evil.example/phish', 'https://erp.example.com'), null)
  assert.equal(erp.safeErpAlertUrl('http://erp.example.com/path', 'https://erp.example.com'), null)
  assert.equal(erp.safeErpAlertUrl('http://localhost:3000/pis/1', 'http://localhost:3000'), 'http://localhost:3000/pis/1')
  assert.equal(erp.safeErpAlertUrl('http://example.com/path', 'http://example.com'), null)
})
