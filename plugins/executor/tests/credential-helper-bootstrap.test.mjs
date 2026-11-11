import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,mkdir,lstat,symlink,copyFile,unlink,realpath} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {bootstrapCredentialHelper, discoverHelperRelease} from '../lib/credential-helper-bootstrap.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const source='0123456789abcdef0123456789abcdef01234567';
const exec=promisify(execFile);
const root=await realpath(await mkdtemp(join(process.env.TMPDIR??tmpdir(),'helper-bootstrap-')));
const bytes=Buffer.from('fixture helper bytes, never executed');
function transport(plugin='codex',mutate=()=>{}) {
 const tag=plugin+'-v0.3.9',name='statewright-credentials-darwin-x64';
 const manifest={schema:'statewright/credential-helper-release/v1',repository:'statewright/statewright',tag,source_sha:source,assets:{[name]:{sha256:sha(bytes),size:bytes.length}}};
 const manifestBytes=()=>Buffer.from(JSON.stringify(manifest));
 const asset=(n,b)=>({name:n,state:'uploaded',size:b.length,digest:'sha256:'+sha(b),browser_download_url:`https://github.com/statewright/statewright/releases/download/${tag}/${n}`});
 const release={tag_name:tag,draft:false,prerelease:false,published_at:'2026-11-11T00:00:00Z',assets:[asset(name,bytes),asset('credential-helper-release.json',manifestBytes())]};
 const state={manifest,release,bytes,commit:{sha:source},requests:[]}; mutate(state);
 const fetch=async(url,options)=>{
  state.requests.push({url,options});
  if(url.includes('/releases/tags/'))return Response.json(release);
  if(url.includes('/commits/'))return Response.json(state.commit);
  if(url.endsWith('/credential-helper-release.json'))return new Response(manifestBytes());
  if(url.endsWith('/'+name))return new Response(state.bytes);
  throw Error('Unexpected fixture request: '+url);
 };
 return {fetch,state,release:{tag},platform:'darwin',arch:'x64'};
}
for(const plugin of ['codex','claude'])test(`${plugin} clean Git package bootstraps an exact Intel helper and reuses verified cache offline`,async()=>{
 const home=await mkdtemp(join(root,plugin)),t=transport(plugin);
 const path=await bootstrapCredentialHelper({...t,home});
 assert.deepEqual(await readFile(path),bytes);
 if(process.platform!=='win32')assert.equal((await lstat(path)).mode&0o777,0o700);
 assert.equal(t.state.requests.length,4);
 assert.ok(t.state.requests.every(r=>r.options.signal===t.state.requests[0].options.signal),'redirects/metadata/asset requests share one overall deadline');
 for(const r of t.state.requests){assert.equal(r.options.redirect,'manual');assert.equal(r.options.headers.Authorization,undefined);}
 assert.equal(await bootstrapCredentialHelper({...t,home,fetch:()=>{throw Error('Offline cache must not fetch');}}),path);
 assert.equal(await readFile(join(home,'.statewright','helpers',t.release.tag,'darwin-x64','receipt.json'),'utf8').then(JSON.parse).then(x=>x.source_sha),source);
});
for(const [label,mutate] of [
 ['mismatched tag',s=>s.release.tag_name='codex-v0.3.8'],
 ['unpublished release',s=>s.release.draft=true],
 ['source mismatch',s=>s.commit.sha='a'.repeat(40)],
 ['missing asset digest',s=>delete s.release.assets[0].digest],
 ['corrupt binary',s=>s.bytes=Buffer.from('wrong')],
 ['foreign download',s=>s.release.assets[0].browser_download_url='https://evil.invalid/helper'],
 ['duplicate binary',s=>s.release.assets.push(s.release.assets[0])],
])test(`bootstrap rejects ${label} without installing a helper`,async()=>{
 const home=await mkdtemp(join(root,'negative-')),t=transport('codex',mutate);
 await assert.rejects(bootstrapCredentialHelper({...t,home}),e=>e.code==='CREDENTIAL_HELPER_INSTALL_FAILED');
});
test('unsupported platforms do not make requests',async()=>{
 await assert.rejects(bootstrapCredentialHelper({home:root,release:{tag:'codex-v0.3.9'},platform:'linux',arch:'arm64',fetch:()=>{throw Error('must not fetch');}}),{code:'CREDENTIAL_HELPER_UNSUPPORTED'});
});
test('unsafe redirects never contact the redirect destination',async()=>{
 const urls=[];
 await assert.rejects(bootstrapCredentialHelper({home:await mkdtemp(join(root,'redirect-')),release:{tag:'codex-v0.3.9'},platform:'darwin',arch:'x64',fetch:async url=>{urls.push(url);return new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}});}}),{code:'CREDENTIAL_HELPER_INSTALL_FAILED'});
 assert.equal(urls.length,2); // Release metadata and tag commit are fetched concurrently.
 assert.ok(urls.every(url=>new URL(url).hostname==='api.github.com'));
});
test('symlinked cache is rejected; corrupted cached bytes are never accepted offline',{skip:process.platform==='win32'},async()=>{
 const home=await mkdtemp(join(root,'cache-')),t=transport();
 const path=await bootstrapCredentialHelper({...t,home});
 await writeFile(path,'corrupt');
 await assert.rejects(bootstrapCredentialHelper({...t,home,fetch:()=>{throw Error('offline');}}),{code:'CREDENTIAL_HELPER_INSTALL_FAILED'});
 const other=await mkdtemp(join(root,'link-'));await mkdir(join(other,'.statewright'));
 await symlink(root,join(other,'.statewright','helpers'));
 await assert.rejects(bootstrapCredentialHelper({...t,home:other}),{code:'CREDENTIAL_HELPER_INSTALL_FAILED'});
});
test('release identity comes from native plugin manifests in both generated layouts',async()=>{
 for(const [plugin,folder,file,version] of [['codex','scripts/lib/desktop-runtime','.codex-plugin/plugin.json','0.3.9+codex.20261111190450'],['claude','executor/lib','.claude-plugin/plugin.json','0.3.9']]){
  const pkg=await mkdtemp(join(root,'layout-'));await mkdir(join(pkg,folder),{recursive:true});await mkdir(join(pkg,file,'..'),{recursive:true});await writeFile(join(pkg,file),JSON.stringify({name:'statewright',version}));
  assert.deepEqual(await discoverHelperRelease(new URL('file://'+join(pkg,folder,'credential-helper-bootstrap.mjs'))),{tag:plugin+'-v0.3.9'});
 }
});

test('cache receipt FIFO and oversized payload cannot stall helper lookup',{skip:process.platform==='win32'},async()=>{
 for(const kind of ['fifo','oversized']){
  const home=await mkdtemp(join(root,'receipt-')),t=transport();
  const path=await bootstrapCredentialHelper({...t,home});
  const receipt=join(path,'..','receipt.json');await unlink(receipt);
  if(kind==='fifo')execFileSync('mkfifo',[receipt]);else await writeFile(receipt,'x'.repeat(20*1024));
  await assert.rejects(bootstrapCredentialHelper({...t,home,fetch:()=>{throw Error('offline');}}),{code:'CREDENTIAL_HELPER_INSTALL_FAILED'});
 }
});

for(const [plugin,folder,manifestFile] of [['codex','scripts/lib/desktop-runtime','.codex-plugin/plugin.json'],['claude','executor/lib','.claude-plugin/plugin.json']])test(`${plugin} clean Git-subdir adapter installs then invokes verified helper protocol without a global helper`,async t=>{
 const home=await mkdtemp(join(root,'invoke-')),pkg=await mkdtemp(join(root,'git-package-')),lib=join(pkg,folder);
 await mkdir(lib,{recursive:true});await mkdir(join(pkg,manifestFile,'..'),{recursive:true});await writeFile(join(pkg,manifestFile),JSON.stringify({name:'statewright',version:'0.3.9'}));
 for(const name of ['credential-store.mjs','credential-helper-bootstrap.mjs','gateway-profile.mjs'])await copyFile(new URL('../lib/'+name,import.meta.url),join(lib,name));
 const tag=plugin+'-v0.3.9';
 const platformName={'darwin-arm64':'darwin-arm64','darwin-x64':'darwin-x64','linux-x64':'linux-x64','win32-x64':'windows-x64.exe'}[process.platform+'-'+process.arch];
 if(!platformName||process.platform==='win32'){t.skip('Synthetic Unix fixture executable; real Windows binary execution remains a hosted artifact gate.');return;}
 const name='statewright-credentials-'+platformName;
 const helper=Buffer.from('#!'+process.execPath+'\nlet raw="";for await(const b of process.stdin)raw+=b;const r=JSON.parse(raw);console.log(JSON.stringify({ok:true,status:"missing",operation:r.operation,gateway:r.gateway}));\n');
 const manifest={schema:'statewright/credential-helper-release/v1',repository:'statewright/statewright',tag,source_sha:source,assets:{[name]:{sha256:sha(helper),size:helper.length}}};
 const mf=Buffer.from(JSON.stringify(manifest));
 const asset=(name,bytes)=>({name,state:'uploaded',size:bytes.length,digest:'sha256:'+sha(bytes),browser_download_url:`https://github.com/statewright/statewright/releases/download/${tag}/${name}`});
 const release={tag_name:tag,draft:false,prerelease:false,published_at:'2026-11-11T00:00:00Z',assets:[asset(name,helper),asset('credential-helper-release.json',mf)]};
 const preload=join(pkg,'fixture-transport.mjs');await writeFile(preload,`const release=${JSON.stringify(release)},manifest=${JSON.stringify(manifest)};globalThis.fetch=async url=>url.includes('/releases/tags/')?Response.json(release):url.includes('/commits/')?Response.json({sha:${JSON.stringify(source)}}):url.endsWith('/credential-helper-release.json')?Response.json(manifest):new Response(Buffer.from(${JSON.stringify(helper.toString('base64'))},'base64'));`);
 const env={...process.env,HOME:home};for(const key of ['STATEWRIGHT_CREDENTIAL_HELPER','STATEWRIGHT_API_KEY','STATEWRIGHT_CREDENTIAL_OS_HOME'])delete env[key];
 const first=await exec(process.execPath,['--import',preload,join(lib,'credential-store.mjs'),'status','https://fixture.invalid'],{env});
 assert.deepEqual(JSON.parse(first.stdout),{ok:true,status:'missing',operation:'status',gateway:'https://fixture.invalid/mcp'});
 await writeFile(preload,'globalThis.fetch=()=>{throw Error("offline");};');
 const second=await exec(process.execPath,['--import',preload,join(lib,'credential-store.mjs'),'status','https://fixture.invalid'],{env});
 assert.equal(second.stdout,first.stdout);
 const globalHelper=join(home,'.statewright','bin','statewright-credentials');await mkdir(join(globalHelper,'..'),{recursive:true});
 await writeFile(globalHelper,'#!'+process.execPath+'\nconsole.log(JSON.stringify({ok:true,source:"existing-global-helper"}));\n',{mode:0o700});
 const existing=await exec(process.execPath,['--import',preload,join(lib,'credential-store.mjs'),'status','https://fixture.invalid'],{env});
 assert.deepEqual(JSON.parse(existing.stdout),{ok:true,source:'existing-global-helper'});
});
