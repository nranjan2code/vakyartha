import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CollectionPage} from '../shared/pagination.ts';
test('local collections page without losing records and reset on new filters',()=>{
 const page=new CollectionPage(),rows=Array.from({length:40},(_,i)=>i);
 assert.deepEqual(page.slice(rows,'all'),rows.slice(0,12));page.index=1;assert.deepEqual(page.slice(rows,'all'),rows.slice(12,24));page.index=3;assert.deepEqual(page.slice(rows,'all'),rows.slice(36));
 assert.deepEqual(page.slice(rows.filter(n=>n%2===0),'even'),rows.filter(n=>n%2===0).slice(0,12));assert.equal(page.index,0);
 page.index=99;assert.deepEqual(page.slice(rows,'all'),rows.slice(0,12));page.index=99;assert.deepEqual(page.slice(rows,'all'),rows.slice(36));
 page.resize(24);assert.equal(page.index,0);assert.deepEqual(page.slice(rows,'all'),rows.slice(0,24));assert.throws(()=>page.resize(0));
 assert.deepEqual(page.slice([],'empty'),[]);assert.equal(page.index,0);assert.equal(rows.length,40);
});
