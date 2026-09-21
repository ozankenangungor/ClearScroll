import assert from 'node:assert/strict';
import {test} from 'node:test';
import {extensionPage,launchExtension,setSettings,waitRegistered} from '../helpers/extension.ts';

test('topic exclusions reach the real semantic and keyword pipelines and update existing units',async()=>{
 const env=await launchExtension();
 try{
  const ui=await extensionPage(env),page=await env.ctx.newPage();
  await page.route('**/scope.html',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><main><p id="case">Jaguar car review with the latest road test.</p><p id="other">A jaguar hunts in the tropical rainforest.</p></main>'}));
  for(const engine of ['cpu','off'] as const)for(const mode of ['precision','balanced','aggressive'] as const){
   for(const excluded of [false,true,false]){
    await setSettings(env,{enabled:true,engine,mode,topics:[{id:'t',text:'jaguar',enabled:true,...(excluded?{excludedPhrases:['car review']}:{})}]});
    await waitRegistered(env,true);
    if(page.url()!==env.base+'/scope.html')await page.goto(env.base+'/scope.html');
    for(let i=0;i<200;i++){
     const state:any=await ui.evaluate(async url=>{const tab=(await chrome.tabs.query({})).find(t=>t.url===url)!;return chrome.tabs.sendMessage(tab.id!,{type:'tab:state'})},page.url()).catch(()=>null);
     const matched=await page.locator('#case').getAttribute('data-clearscroll')==='blurred';
     if(state?.analyzed>=2&&matched===!excluded&&await page.locator('#other').getAttribute('data-clearscroll')==='blurred')break;
     await page.waitForTimeout(100);
    }
    assert.equal(await page.locator('#case').getAttribute('data-clearscroll')==='blurred',!excluded,`${engine}/${mode}/${excluded}`);
    assert.equal(await page.locator('#other').getAttribute('data-clearscroll'),'blurred');
   }
  }
  await ui.goto(`chrome-extension://${env.extId}/options/options.html`);
  const details=ui.locator('.topic-scope');await details.locator('summary').click();
  await details.locator('textarea').fill('car review\nC++');
  await ui.getByRole('button',{name:'Save changes',exact:true}).click();
  await ui.reload();await ui.locator('.topic-scope summary').click();
  assert.equal(await ui.locator('.topic-scope textarea').inputValue(),'car review\nC++');
 }finally{await env.close()}
});
