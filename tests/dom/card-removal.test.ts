/** Regression derived from a live BBC card; deterministic replay of its two
 * matching unit verdicts. Neighbor is an authored control, not a site observation. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {before,after,test} from 'node:test';
import type {Browser,Page} from 'playwright';
import {launch,harnessPage,waitPending,settle} from '../helpers/dom-page.ts';
let browser:Browser;
before(async()=>{browser=await launch()});after(async()=>{await browser.close()});
const fixture=fs.readFileSync(new URL('../fixtures/pages/bbc-card-removal.html',import.meta.url),'utf8');
const state=(p:Page,id:string)=>p.locator('#'+id).getAttribute('data-clearscroll');
async function ready(){const p=await harnessPage(browser,fixture);await p.evaluate(()=>(window as any).harness.apply());await waitPending(p,1);await p.evaluate(()=>(window as any).harness.respond(0,'Spain'));await settle(p);assert.equal(await state(p,'observed-card'),'blurred');return p;}
test('removing the last matching BBC card unit restores the card; reinsertion reclassifies it',async()=>{
 const p=await ready();try{
 const neighbor=await p.locator('#neighbor').evaluate(e=>e.outerHTML);
 await p.evaluate(()=>{(window as any).removedHeadline=document.querySelector('#headline')!;(window as any).savedParent=(window as any).removedHeadline.parentElement;(window as any).removedHeadline.remove()});await settle(p);
 assert.equal(await state(p,'observed-card'),'blurred','remaining matched description still owns blur');
 await p.locator('#description').evaluate(e=>e.remove());await settle(p);
 assert.equal(await state(p,'observed-card'),null,'no matching member remains; unchanged metadata must not keep stale blur');
 assert.equal(await p.locator('#neighbor').evaluate(e=>e.outerHTML),neighbor,'neighbor never changes');
 await p.evaluate(()=>(window as any).savedParent.append((window as any).removedHeadline));await waitPending(p,1);await p.evaluate(()=>(window as any).harness.respond(0,'Spain'));await settle(p);
 assert.equal(await state(p,'observed-card'),'blurred','same reinserted matching node is classifiable');
 await p.locator('#observed-card img').click();assert.equal(await state(p,'observed-card'),'revealed');
 await p.evaluate(()=>(window as any).harness.apply({enabled:false}));await settle(p);assert.equal(await state(p,'observed-card'),null);
 }finally{await p.close()}
});
test('detached BBC cards carry no orphaned blur through pause and reinsertion',async()=>{
 const p=await ready();try{
 await p.evaluate(()=>{(window as any).removedCard=document.querySelector('#observed-card')!;(window as any).removedCard.remove()});await settle(p);
 assert.equal(await p.evaluate(()=>(window as any).removedCard.getAttribute('data-clearscroll')),null,'detached card visuals are disposed');
 await p.evaluate(()=>(window as any).harness.apply({enabled:false}));await p.evaluate(()=>document.querySelector('main')!.prepend((window as any).removedCard));await settle(p);
 assert.equal(await state(p,'observed-card'),null,'paused reinsertion cannot resurrect stale blur');
 assert.equal(await state(p,'neighbor'),null);
 }finally{await p.close()}
});
test('a matched BBC unit moved to another card releases the old owner and is reclassified',async()=>{
 const p=await ready();try{
 await p.evaluate(()=>{document.querySelector('#description')!.remove();document.querySelector('#neighbor')!.append(document.querySelector('#headline')!)});
 await waitPending(p,1);await p.evaluate(()=>(window as any).harness.respond(0,'Spain'));await settle(p);
 assert.equal(await state(p,'observed-card'),null,'old metadata is no longer owned by the moved match');
 assert.equal(await state(p,'neighbor'),'blurred','new card contains the actual matching unit');
 await p.evaluate(()=>(window as any).harness.controller.stop());assert.equal(await state(p,'neighbor'),null);
 }finally{await p.close()}
});
test('same-card reordering preserves ownership without a new classification request',async()=>{
 const p=await ready();try{
 await p.evaluate(()=>{const el=document.querySelector('#headline')!;el.parentElement!.append(el)});await settle(p);
 assert.equal(await state(p,'observed-card'),'blurred');assert.equal(await p.evaluate(()=>(window as any).harness.pendingCount()),0);
 assert.equal(await state(p,'neighbor'),null);
 }finally{await p.close()}
});
