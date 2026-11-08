import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedDownload,extractExamples } from './import-command-corpus.mjs';
test('imports command text without evaluating substitutions or chaining',()=>{
  assert.deepEqual(extractExamples('nl2bash','cat x\nrm x && echo done\n'),['cat x','rm x && echo done']);
  assert.deepEqual(extractExamples('tldr','- Example:\n`echo $(rm {{path}})`\n'),['echo $(rm {{path}})']);
  assert.deepEqual(extractExamples('syntax','arbitrary source'),[]);
});
test('rejects unknown origins and HTTP errors; records missing optional sources',async()=>{
  await assert.rejects(boundedDownload('https://example.com/data'));
  await assert.rejects(boundedDownload('https://api.github.com/data',async()=>({ok:false,status:403})));
  assert.equal(await boundedDownload('https://raw.githubusercontent.com/missing',async()=>({status:404})),null);
});
test('caps download size before persisting and preserves literal bytes',async()=>{
  const fetcher=async()=>({ok:true,status:200,body:(async function*(){yield Buffer.from('literal command');})()});
  assert.equal((await boundedDownload('https://raw.githubusercontent.com/data',fetcher)).toString(),'literal command');
  const large=async()=>({ok:true,status:200,body:(async function*(){yield Buffer.alloc(8*1024*1024+1);})()});
  await assert.rejects(boundedDownload('https://raw.githubusercontent.com/data',large));
});
