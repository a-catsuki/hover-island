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
