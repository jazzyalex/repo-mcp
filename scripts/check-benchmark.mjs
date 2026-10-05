// Independent checks are outside the files exposed to ChatGPT.
import assert from 'node:assert/strict';
import {writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const root=path.resolve('.trial/benchmark');
const {quote}=await import(pathToFileURL(path.join(root,'bug/src/quote.js')));
const {listOrders}=await import(pathToFileURL(path.join(root,'feature/src/orders.js')));
const {listResponse}=await import(pathToFileURL(path.join(root,'feature/src/api.js')));
const {encodeCursor,decodeCursor}=await import(pathToFileURL(path.join(root,'feature/src/cursor.js')));
const results=[];
function check(name,fn){try{fn();results.push({name,passed:true});}catch(e){results.push({name,passed:false,error:e.message});}}
check('pricing matrix of quantities and discounts',()=>{
 for(let quantity=0;quantity<=12;quantity++) for(const percent of [0,1,17,50,99,100]){
  const subtotal=quantity*2500,merchandise=Math.round(subtotal*(100-percent)/100),shipping=subtotal===0||subtotal>=10000?0:800;
  assert.deepEqual(quote([{sku:'book',quantity}],percent),{subtotal,merchandise,shipping,total:merchandise+shipping});
 }
});
const rows=Array.from({length:37},(_,i)=>({id:String(i).padStart(3,'0'),createdAt:`2026-01-${String(1+Math.floor(i/5)).padStart(2,'0')}`,status:i%3?'open':'closed'}));
check('full traversal for every page size and filter',()=>{
 for(const limit of [1,2,5,20,50]) for(const status of [undefined,'open','closed','missing']){
  const expected=rows.filter(x=>status===undefined||x.status===status);let cursor;let actual=[];
  for(let step=0;step<50;step++){
   const page=listOrders([...rows].reverse(),{limit,status,...(cursor?{cursor}:{})});
   actual.push(...page.items);if(page.nextCursor===null)break;cursor=page.nextCursor;
   assert.ok(step<49,'pagination did not terminate');
  }
  assert.deepEqual(actual,expected);
 }
});
check('API forwards continuation cursor',()=>{
 const first=listResponse(rows,{limit:3,status:'open'});
 const second=listResponse(rows,{limit:3,status:'open',cursor:first.paging.nextCursor});
 assert.deepEqual(second.data,rows.filter(x=>x.status==='open').slice(3,6));
});
check('default limit and missing cursor tuple',()=>{
 assert.equal(listOrders(rows).items.length,20);
 assert.deepEqual(listOrders(rows,{cursor:encodeCursor({createdAt:'2026-01-01',id:'001a'})}).items.slice(0,2),rows.slice(2,4));
});
check('strict malformed cursor and tuple validation',()=>{
 const valid=encodeCursor({createdAt:'2026-01-01',id:'x'});
 for(const cursor of [valid+'=',valid+'!', '',Buffer.from('null').toString('base64url'),Buffer.from('{"createdAt":1,"id":"x"}').toString('base64url')])assert.throws(()=>decodeCursor(cursor),RangeError);
 for(const tuple of [{createdAt:'',id:'x'},{createdAt:'x',id:''},null])assert.throws(()=>encodeCursor(tuple),RangeError);
});
check('protected files and review patch unchanged',()=>{
 const hashes=JSON.parse(readFileSync('evidence/benchmark/protected-hashes.json','utf8'));
 for(const [file,hash] of Object.entries(hashes))assert.equal(createHash('sha256').update(readFileSync(path.join(root,file))).digest('hex'),hash,file);
});
writeFileSync('evidence/benchmark/independent-checks.json',JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify(results,null,2));
process.exitCode=results.every(x=>x.passed)?0:1;
