import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
const source=await readFile(new URL('../src/lib/connectionSources.ts',import.meta.url),'utf8')
const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
const context=vm.createContext({exports:{}})
vm.runInContext(output,context)
const {notificationAllowed}=context.exports
const app={id:'whatsapp',name:'WhatsApp',url:'https://web.whatsapp.com',notificationSources:['WhatsApp Desktop'],notifications:true}
test('connected native app alerts match explicit source labels, including case differences',()=>{
 assert.equal(notificationAllowed({app:'whatsapp desktop'},[app],[]),true)
})
test('a browser source is not falsely attributed to a Gmail account',()=>{
 assert.equal(notificationAllowed({app:'Google Chrome'},[{...app,id:'gmail',name:'Gmail',notificationSources:['Gmail']}],[]),false)
})
test('muting a connection takes precedence over a shortcut for that app',()=>{
 assert.equal(notificationAllowed({app:'WhatsApp'},[{...app,notifications:false}],[{name:'WhatsApp'}]),false)
})

test('single-letter app names match exactly without matching unrelated apps',()=>{
 const x={...app,name:'X',notificationSources:['X']}
 assert.equal(notificationAllowed({app:'X'},[x],[]),true)
 assert.equal(notificationAllowed({app:'Xbox'},[x],[]),false)
})

test('an exact notification source takes precedence over a generic prefix rule',()=>{
 const generic={...app,id:'outlook',name:'Outlook',notificationSources:[],notifications:false}
 const specific={...app,id:'outlook-new',name:'Outlook New',notificationSources:[],notifications:true}
 assert.equal(notificationAllowed({app:'Outlook New'},[generic,specific],[]),true)
 assert.equal(notificationAllowed({app:'Outlook'},[generic,specific],[]),false)
})
