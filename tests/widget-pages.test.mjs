import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'
import ts from 'typescript'
const source=await readFile(new URL('../src/lib/widgetPages.ts',import.meta.url),'utf8')
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext}}).outputText
const {widgetPages}=await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
const widget=(kind,index)=>({kind,id:`${kind}-${index}`,enabled:true,order:index})
test('fixed pages preserve order and fit every cell without overlap',()=>{
 const items=['media','weather','calendar','notes','dock','focus','clock','controls','nearby','ai','airdrop'].map(widget)
 for(const columns of [1,2]){
  const pages=widgetPages(items,columns)
  assert.deepEqual(pages.flat().map(slot=>slot.widget.kind),items.filter(item=>item.kind!=='airdrop').map(item=>item.kind))
  for(const page of pages){const occupied=new Set();for(const slot of page){assert.ok(slot.row+slot.rows<=3);assert.ok(slot.column+slot.columns<=columns+1);for(let y=slot.row;y<slot.row+slot.rows;y++)for(let x=slot.column;x<slot.column+slot.columns;x++){const key=`${x},${y}`;assert.equal(occupied.has(key),false);occupied.add(key)}}}
 }
})
test('Calendar has readable full-page space; companion widgets grow and disabled widgets stay hidden',()=>{
 const today=widgetPages(['media','weather','calendar'].map(widget))
 assert.deepEqual(today.map(page=>page.map(slot=>slot.widget.kind)),[['media','weather'],['calendar']])
 assert.ok(today[0].every(slot=>slot.rows===2))
 assert.equal(today[1][0].rows,2)
 assert.equal(today[1][0].columns,2)
 const pages=widgetPages([widget('notes',0),widget('controls',1),{...widget('airdrop',2)}, {...widget('focus',3),enabled:false}])
 assert.deepEqual(pages.map(page=>page.map(slot=>slot.widget.kind)),[['notes'],['controls']])
 assert.equal(pages[1][0].rows,2)
 assert.equal(pages[0][0].columns,2, 'A lone widget fills its row rather than leaving a blank half')
})

test('explicit Compact, Wide and Full sizes keep their requested geometry',()=>{
 const items=[
  {...widget('notes',0),size:'compact'},
  {...widget('weather',1),size:'compact'},
  {...widget('dock',2),size:'wide'},
  {...widget('ai',3),size:'full'},
 ]
 const pages=widgetPages(items)
 assert.deepEqual(pages[0].map(({column,row,columns,rows})=>({column,row,columns,rows})),[
  {column:1,row:1,columns:1,rows:1},
  {column:2,row:1,columns:1,rows:1},
  {column:1,row:2,columns:2,rows:1},
 ])
 assert.deepEqual(pages[1].map(({column,row,columns,rows})=>({column,row,columns,rows})),[
  {column:1,row:1,columns:2,rows:2},
 ])
})

test('legacy unsized single-row layouts still fill their available row',()=>{
 const pages=widgetPages([widget('media',0),widget('weather',1)])
 assert.deepEqual(pages[0].map(slot=>slot.rows),[2,2])
 assert.deepEqual(pages[0].map(slot=>slot.columns),[1,1])
})
