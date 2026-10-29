import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownsSurfaceEvent } from '../src/surface-ownership.ts';
test('identical surface IDs never transfer action/edit authority across owners',()=>{
 const chat=new EventTarget(),app=new EventTarget(),preview=new EventTarget(),owners=new Map([['main',chat]]);
 const from=(target:EventTarget)=>({composedPath:()=>[target]} as unknown as Event);
 assert.equal(ownsSurfaceEvent(from(chat),owners,'main'),true);
 assert.equal(ownsSurfaceEvent(from(app),owners,'main'),false);
 assert.equal(ownsSurfaceEvent(from(preview),owners,'main'),false);
 assert.equal(ownsSurfaceEvent(from(chat),owners,'missing'),false);
 owners.clear();assert.equal(ownsSurfaceEvent(from(chat),owners,'main'),false);
});
