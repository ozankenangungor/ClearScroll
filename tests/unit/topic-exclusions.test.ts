import assert from 'node:assert/strict';
import {test} from 'node:test';
import {decide,prepareTopic,LEXICAL_PARAMS} from '../../src/shared/classifier.ts';
import {normalizeSettings} from '../../src/shared/settings.ts';
import {isClassifyRequest} from '../../src/shared/protocol.ts';
const p={threshold:.005,minSemanticChars:24,lexical:LEXICAL_PARAMS.balanced};
const prep=(text:string,excludedPhrases?:string[],id='t')=>prepareTopic({id,text,excludedPhrases} as any,Float32Array.of(1,0),p);
test('explicit exclusions apply to semantic AND exact lexical matches',()=>{
 for(const v of [null,Float32Array.of(1,0)]){
  const t=prep('jaguar',['car review']);
  assert.equal(decide(['Jaguar car review with the latest road test.'],v,2,[t],p)[0]!.matched,false);
  assert.equal(decide(['A jaguar hunts in the tropical rainforest.'],v,2,[t],p)[0]!.matched,true);
 }
});
test('whole literal phrases: case/accent/space normalized, no partial-token or regex expansion',()=>{
 const t=prep('jaguar',['CÁR review','C++']);
 for(const text of ['Jaguar CAR   REVIEW today','Jaguar C++ guide'])assert.equal(decide([text],null,2,[t],p)[0]!.matched,false,text);
 for(const text of ['Jaguar car reviews','Jaguar scar review','Jaguar car beautiful review','Jaguar CCCC guide'])assert.equal(decide([text],null,2,[t],p)[0]!.matched,true,text);
});
test('exclusion is local to one topic and one unit; another allowed topic still matches',()=>{
 const rows=decide(['Jaguar car review with electric vehicles.','A jaguar hunts in the jungle.'],Float32Array.of(1,0,1,0),2,[prep('jaguar',['car review']),prep('vehicles',undefined,'other')],p);
 assert.equal(rows[0]!.topicId,'other');assert.equal(rows[1]!.topicId,'t');
});
test('missing and empty exclusions preserve exact old decisions',()=>{
 const texts=['Jaguar car review with a road test.','short text'];
 assert.deepEqual(decide(texts,null,2,[prep('jaguar')],p),decide(texts,null,2,[prep('jaguar',[])],p));
});
test('stored exclusions stay bounded, survive normalization and do not change legacy topics',()=>{
 const n=normalizeSettings({topics:[{id:'t',text:'jaguar',excludedPhrases:[' car   review ','car review',3,'','x'.repeat(121)]}]});
 assert.deepEqual((n.topics[0] as any).excludedPhrases,['car review']);
 assert.deepEqual(normalizeSettings(n),n);
 assert.deepEqual(normalizeSettings({topics:[{id:'t',text:'jaguar'}]}).topics,[{id:'t',text:'jaguar',enabled:true}]);
});
test('protocol rejects unbounded or malformed exclusion snapshots',()=>{
 const msg={type:'cs:classify',generation:1,mode:'balanced',texts:['hello'],topics:[{id:'t',text:'jaguar',excludedPhrases:['car review']}]};
 assert.equal(isClassifyRequest(msg),true);
 for(const x of ['bad',[1],Array(11).fill('a'),['x'.repeat(121)]])assert.equal(isClassifyRequest({...msg,topics:[{...msg.topics[0],excludedPhrases:x}]}),false);
});
test('literal scope takes precedence even in mixed relevant text, without interpreting negation',()=>{
 const text='A jaguar conservation charity discusses a car review fundraiser.';
 assert.equal(decide([text],Float32Array.of(1,0),2,[prep('jaguar')],p)[0]!.matched,true);
 assert.equal(decide([text],Float32Array.of(1,0),2,[prep('jaguar',['car review'])],p)[0]!.matched,false);
 assert.equal(decide(['This Jaguar article is not a car review.'],null,2,[prep('jaguar',['car review'])],p)[0]!.matched,false);
});
