"""Create a fresh, synthetic multi-module benchmark. Never overwrite prior runs."""
from pathlib import Path
import subprocess, json
root = Path('.trial/benchmark').resolve()
root.mkdir()
files = {
'AGENTS.md': '''This is a disposable synthetic order-service benchmark, with three independent tasks.
Only edit source paths exposed as editable_files by repo_info. Never edit tests or metadata.
Run the task's fixed test suite before and after edits; inspect git_diff with its task prefix.
Use search to locate relevant logic and read for line numbers/hash. Check exact SHA before edits.
Review tasks are read-only. Report concrete failures with file/line and reproduction input.
Do not claim tools ran when blocked. Do not access another repository or use other plugins.
''',
'README.md': '''# Parcel Desk
Small dependency-free order-processing library used by a demo API.
Modules are separated into pricing, order assembly, paging, and reservations.
Each task folder is independent. This is a synthetic benchmark, not production code.
bug/: diagnose and repair quote totals. feature/: implement cursor paging.
review/: inspect the proposed reservation patch against HEAD; do not edit it.
''',
'package.json': '{"private":true,"type":"module"}\n',
'bug/README.md': '''# Quote contract
All money values are integer cents. Unit prices and quantities are nonnegative integers.
Percent discount applies once to the merchandise subtotal (rounded to nearest cent).
Shipping is free when the ORIGINAL merchandise subtotal is at least 10000 cents,
otherwise it costs 800 cents. Empty carts cost zero including shipping.
The returned total equals discounted merchandise plus shipping. Never mutate input.
''',
'bug/src/catalog.js': '''export const catalog = Object.freeze({ book: 2500, lamp: 6500, cable: 1500 });
export function priceFor(sku) {
  if (!Object.hasOwn(catalog, sku)) throw new RangeError('Unknown SKU');
  return catalog[sku];
}
''',
'bug/src/pricing.js': '''export function discount(subtotal, percent) {
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw new RangeError('Invalid discount');
  return Math.round(subtotal * (100 - percent) / 100);
}
export function shipping(subtotal) {
  return subtotal === 0 || subtotal >= 10000 ? 0 : 800;
}
''',
'bug/src/quote.js': '''import { priceFor } from './catalog.js';
import { discount, shipping } from './pricing.js';
export function quote(items, percent = 0) {
  const subtotal = items.reduce((sum, item) => {
    if (!Number.isInteger(item.quantity) || item.quantity < 0) throw new RangeError('Invalid quantity');
    return sum + priceFor(item.sku) * item.quantity;
  }, 0);
  const merchandise = discount(subtotal, percent);
  const delivery = shipping(merchandise);
  return { subtotal, merchandise, shipping: delivery, total: discount(merchandise + delivery, percent) };
}
''',
'bug/test/quote.test.js': '''import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quote } from '../src/quote.js';
test('no discount small order', () => assert.deepEqual(quote([{sku:'book',quantity:1}]), {subtotal:2500,merchandise:2500,shipping:800,total:3300}));
test('discount applies once', () => assert.equal(quote([{sku:'book',quantity:1}],20).total,2800));
test('free shipping uses original subtotal', () => assert.equal(quote([{sku:'book',quantity:4}],20).shipping,0));
test('large discounted order total', () => assert.equal(quote([{sku:'book',quantity:4}],20).total,8000));
test('empty order is free', () => assert.equal(quote([],50).total,0));
test('100 percent leaves shipping payable', () => assert.equal(quote([{sku:'cable',quantity:1}],100).total,800));
test('unknown SKU rejected', () => assert.throws(()=>quote([{sku:'missing',quantity:1}]),RangeError));
test('fractional quantity rejected', () => assert.throws(()=>quote([{sku:'book',quantity:0.5}]),RangeError));
test('invalid percent rejected', () => assert.throws(()=>quote([],101),RangeError));
test('input preserved', () => { const items=[{sku:'book',quantity:2}]; const before=structuredClone(items); quote(items,10); assert.deepEqual(items,before); });
''',
'feature/README.md': '''# Cursor pagination contract
Implement listOrders(orders, options) where options defaults to {} and contains:
- limit: integer 1..50, default 20; invalid values throw RangeError.
- status: optional exact status filter; omit it for all statuses.
- cursor: optional opaque cursor returned by the preceding page.
Return {items, nextCursor}. Sort by createdAt ascending then id ascending, independent
of input order. createdAt and id are strings; compare lexically without locale sorting.
Apply status filter before pagination. Continue strictly after BOTH cursor tuple fields.
nextCursor is null unless more matching records exist after the current page.
encodeCursor/decodeCursor in cursor.js must round-trip {createdAt,id} via base64url JSON;
malformed or noncanonical encodings and nonempty-string field violations throw RangeError.
No input mutation. Results must contain no duplicates or skipped records for equal timestamps.
The public API listResponse delegates options through and returns {data, paging:{nextCursor}}.
Fixtures use valid ISO timestamps and unique nonempty ids. No database or HTTP server needed.
''',
'feature/src/cursor.js': '''export function encodeCursor(tuple) {
  throw new Error('Cursor encoding not implemented');
}
export function decodeCursor(cursor) {
  throw new Error('Cursor decoding not implemented');
}
''',
'feature/src/orders.js': '''export function listOrders(orders, options = {}) {
  return { items: orders.slice(0, options.limit ?? 20), nextCursor: null };
}
''',
'feature/src/api.js': '''import { listOrders } from './orders.js';
export function listResponse(orders, options = {}) {
  const page = listOrders(orders);
  return { data: page.items, paging: { nextCursor: page.nextCursor } };
}
''',
'feature/test/orders.test.js': '''import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listOrders } from '../src/orders.js';
import { listResponse } from '../src/api.js';
import { encodeCursor, decodeCursor } from '../src/cursor.js';
const a={id:'a',createdAt:'2026-01-01',status:'open'};
const b={id:'b',createdAt:'2026-01-01',status:'closed'};
const c={id:'c',createdAt:'2026-01-01',status:'open'};
const d={id:'d',createdAt:'2026-01-02',status:'open'};
const data=[d,c,b,a];
test('sorts tied timestamps using id',()=>assert.deepEqual(listOrders(data).items,[a,b,c,d]));
test('cursor round trip',()=>{const tuple={createdAt:a.createdAt,id:a.id};assert.deepEqual(decodeCursor(encodeCursor(tuple)),tuple);});
test('pages tied timestamps without duplicates',()=>{const one=listOrders(data,{limit:2});const two=listOrders(data,{limit:2,cursor:one.nextCursor});assert.deepEqual([...one.items,...two.items],[a,b,c,d]);assert.equal(two.nextCursor,null);});
test('filters before slicing',()=>assert.deepEqual(listOrders(data,{status:'open',limit:2}).items,[a,c]));
test('last filtered page has no cursor',()=>assert.equal(listOrders(data,{status:'closed',limit:1}).nextCursor,null));
test('limit validation',()=>{for(const limit of [0,51,1.5,'2',null]) assert.throws(()=>listOrders(data,{limit}),RangeError);});
test('invalid cursor rejected',()=>{for(const cursor of ['!!!',Buffer.from('{}').toString('base64url'),Buffer.from('{"id":"a","createdAt":""}').toString('base64url')])assert.throws(()=>listOrders(data,{cursor}),RangeError);});
test('does not mutate input',()=>{const copy=structuredClone(data);listOrders(data);assert.deepEqual(data,copy);});
test('API forwards limit and filter',()=>assert.deepEqual(listResponse(data,{status:'closed',limit:1}).data,[b]));
test('empty result',()=>assert.deepEqual(listOrders([]),{items:[],nextCursor:null}));
''',
'review/README.md': '''# Reservation contract
reserve(state, request) reserves positive integer quantity of a SKU. state is
{stock:{sku:count}, reservations:{requestId:{sku,quantity}}}.
Repeated requests with the same id and identical payload are idempotent: return state
without changing inventory. Reusing an id with a different payload throws RangeError.
Unavailable SKU, insufficient stock or invalid quantity throw RangeError without changing state.
All operations return a new state on success; caller-owned input must remain unchanged.
The proposed patch is the uncommitted diff in review/src/reserve.js against HEAD.
Review it for correctness, do not fix it. Existing tests are deliberately limited;
a green suite alone is not sufficient evidence of correctness.
''',
'review/src/reserve.js': '''export function reserve(state, request) {
  const {id,sku,quantity}=request;
  if (!Number.isInteger(quantity) || quantity < 1) throw new RangeError('Invalid quantity');
  const prior=state.reservations[id];
  if(prior) {
    if(prior.sku !== sku || prior.quantity !== quantity) throw new RangeError('Conflicting request');
    return state;
  }
  if(!Object.hasOwn(state.stock,sku) || state.stock[sku] < quantity) throw new RangeError('Insufficient stock');
  return {...state,stock:{...state.stock,[sku]:state.stock[sku]-quantity},reservations:{...state.reservations,[id]:{sku,quantity}}};
}
''',
'review/test/reserve.test.js': '''import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reserve} from '../src/reserve.js';
test('successful reservation returns remaining stock',()=>assert.equal(reserve({stock:{book:5},reservations:{}},{id:'r1',sku:'book',quantity:2}).stock.book,3));
test('rejects negative quantity',()=>assert.throws(()=>reserve({stock:{book:5},reservations:{}},{id:'r1',sku:'book',quantity:-1}),RangeError));
test('rejects overselling',()=>assert.throws(()=>reserve({stock:{book:1},reservations:{}},{id:'r1',sku:'book',quantity:2}),RangeError));
'''
}
for name,content in files.items():
    target=root/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_text(content)
def git(*args):
    return subprocess.check_output(['/usr/bin/git','-c','core.hooksPath=/dev/null',*args],cwd=root,text=True)
git('init','-b','mcp-benchmark');git('add','.')
git('-c','user.name=MCP Trial','-c','user.email=trial@example.invalid','-c','commit.gpgsign=false','commit','-m','Synthetic benchmark baseline')
(root/'review/src/reserve.js').write_text('''export function reserve(state, request) {
  const {id,sku,quantity}=request;
  if (!Number.isInteger(quantity) || quantity < 1) throw new RangeError('Invalid quantity');
  if(!Object.hasOwn(state.stock,sku) || state.stock[sku] < quantity) throw new RangeError('Insufficient stock');
  const stock=state.stock;
  stock[sku]-=quantity;
  const prior=state.reservations[id];
  if(prior) return {...state,stock};
  return {...state,stock,reservations:{...state.reservations,[id]:{sku,quantity}}};
}
''')
policy={'files':list(files),'editable':['bug/src/pricing.js','bug/src/quote.js','feature/src/cursor.js','feature/src/orders.js','feature/src/api.js'],'tests':['bug/test/quote.test.js','feature/test/orders.test.js','review/test/reserve.test.js']}
Path('.trial/benchmark-policy.json').write_text(json.dumps(policy,indent=2)+'\n')
print(f'Created {len(files)} files at {root}')
