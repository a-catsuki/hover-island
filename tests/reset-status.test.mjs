import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
const exports = {}
const source = await readFile(new URL('../src/lib/resetStatus.ts', import.meta.url),'utf8')
vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports,Date})
test('an estimated reset crossing its time awaits confirmation, never invents landing',()=>{
  const event={status:'expected',landingAt:1000}
  assert.equal(exports.effectiveResetStatus(event,999),'expected')
  assert.equal(exports.effectiveResetStatus(event,1000),'awaiting_confirmation')
  assert.equal(exports.effectiveResetStatus(event,2000),'awaiting_confirmation')
  assert.equal(exports.effectiveResetStatus({...event,status:'landed'},999),'landed')
  assert.equal(exports.effectiveResetStatus({...event,landingAt:null},2000),'expected')
})
