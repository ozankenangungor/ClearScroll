/** Actual extension/encoder regression on the captured BBC card structure. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {launchExtension,setSettings,waitRegistered,waitAttr} from '../helpers/extension.ts';
test('native card filtering releases removed members and reanalyses reinsertion',async()=>{
 const env=await launchExtension();try{
 await setSettings(env,{topics:[{id:'t',text:'football',enabled:true}]});await waitRegistered(env,true);
 const p=await env.ctx.newPage();await p.goto(env.base+'/bbc-card-removal.html');await waitAttr(p,'#observed-card','blurred');
 assert.equal(await p.locator('#neighbor').getAttribute('data-clearscroll'),null);
 await p.evaluate(()=>{(window as any).removedHeadline=document.querySelector('#headline')!;(window as any).savedParent=(window as any).removedHeadline.parentElement;(window as any).removedHeadline.remove();document.querySelector('#description')!.remove()});
 await waitAttr(p,'#observed-card',null);assert.equal(await p.locator('#neighbor').getAttribute('data-clearscroll'),null);
 await p.evaluate(()=>(window as any).savedParent.append((window as any).removedHeadline));await waitAttr(p,'#observed-card','blurred');
 await p.locator('#observed-card').click();await waitAttr(p,'#observed-card','revealed');
 await setSettings(env,{enabled:false});await waitAttr(p,'#observed-card',null);
 assert.equal(await p.locator('[data-clearscroll]').count(),0);
 }finally{await env.close()}
});
