import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import ts from 'typescript'
import { readFile } from 'node:fs/promises'
const source = await readFile(new URL('../src/lib/ambientSurface.ts',import.meta.url),'utf8')
const result = ts.transpileModule(source,{ compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022} })
const box = { exports:{},Number,Math }; vm.runInNewContext(result.outputText,box)
const {ambientSurfaceSize}=box.exports

test('ambient backdrops have a fixed allocation ceiling across large monitors and DPI scales',()=>{
  for(const [width,height] of [[1280,800],[3840,2160],[7680,4320],[15360,8640],[1080,7680],[32000,1000]]) {
    const size=ambientSurfaceSize(width,height)
    assert.ok(size.width<=512 && size.height<=320)
    assert.ok(size.width*size.height*4<=655360)
    assert.ok(Math.abs(size.width/size.height-width/height)<Math.max(.2,width/height*.05))
    const scene=ambientSurfaceSize(width,height,960,600)
    assert.ok(scene.width*scene.height*4<=2304000)
  }
})

test('transient zero or invalid viewport sizes cannot allocate an unbounded canvas',()=>{
  for(const value of [0,-10,NaN,Infinity]) {
    const size=ambientSurfaceSize(value,value)
    assert.equal(size.width,1);assert.equal(size.height,1)
  }
})
