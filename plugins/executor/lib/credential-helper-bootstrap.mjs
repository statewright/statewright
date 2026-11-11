import {createHash} from 'node:crypto';
import {lstat,mkdir,mkdtemp,open,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';

const REPOSITORY='statewright/statewright';
const API=`https://api.github.com/repos/${REPOSITORY}`;
const SCHEMA='statewright/credential-helper-release/v1';
const MAX_BINARY=32*1024*1024;
const inflight=new Map();
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=()=>Object.assign(new Error('Statewright could not verify/install the native credential helper for this plugin release. Check connectivity and that the exact plugin release is published, then retry Connect.'),{code:'CREDENTIAL_HELPER_INSTALL_FAILED'});
const names={
 'darwin-arm64':'statewright-credentials-darwin-arm64',
 'darwin-x64':'statewright-credentials-darwin-x64',
 'linux-x64':'statewright-credentials-linux-x64',
 'win32-x64':'statewright-credentials-windows-x64.exe',
};

export async function discoverHelperRelease(moduleUrl=import.meta.url) {
 const here=dirname(fileURLToPath(moduleUrl));
 const candidates=[];
 for(let dir=here,i=0;i<5;i++,dir=dirname(dir)){
  candidates.push([join(dir,'.codex-plugin/plugin.json'),'codex'],[join(dir,'.claude-plugin/plugin.json'),'claude']);
 }
 // Source executor uses the sibling Codex manifest. Installed runtimes use
 // their own nearest host manifest above; no latest-release or version guess.
 candidates.push([resolve(here,'../../codex/.codex-plugin/plugin.json'),'codex']);
 for(const [path,plugin] of candidates){
  let body;try{body=await readFile(path,'utf8');}catch(error){if(error.code==='ENOENT')continue;throw fail();}
  const manifest=JSON.parse(body);
  if(manifest.name!=='statewright'||!/^\d+\.\d+\.\d+(?:\+codex\.\d+)?$/.test(manifest.version??''))throw fail();
  return {tag:`${plugin}-v${manifest.version.split('+')[0]}`};
 }
 throw fail();
}

function safeUrl(value,api=false){
 const url=new URL(value);
 const hosts=api?['api.github.com']:['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'];
 if(url.protocol!=='https:'||url.username||url.password||url.port||!hosts.includes(url.hostname))throw fail();
 return url.href;
}

async function download(url,maxBytes,fetch,signal,api=false){
 url=safeUrl(url,api);
 for(let redirects=0;redirects<5;redirects++){
  const response=await fetch(url,{method:'GET',redirect:'manual',signal,headers:{Accept:api?'application/vnd.github+json':'application/octet-stream','User-Agent':'statewright-credential-bootstrap','X-GitHub-Api-Version':'2022-11-28'}});
  if([301,302,303,307,308].includes(response.status)){
   await response.body?.cancel();
   url=safeUrl(new URL(response.headers.get('location'),url).href,api);continue;
  }
  if(!response.ok||!response.body)throw fail();
  if(Number(response.headers.get('content-length'))>maxBytes)throw fail();
  let size=0;const chunks=[];
  for await(const chunk of response.body){size+=chunk.length;if(size>maxBytes)throw fail();chunks.push(chunk);}
  return Buffer.concat(chunks);
 }
 throw fail();
}

async function safeDirectory(home,parts){
 let dir=home;
 for(const part of parts){
  dir=join(dir,part);await mkdir(dir,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
  const stat=await lstat(dir);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(process.platform!=='win32'&&((stat.mode&0o022)!==0||(process.getuid&&stat.uid!==process.getuid()))))throw fail();
 }
 return dir;
}

async function cacheHit(dir,{tag,name,platform}){
 try{
  const receiptPath=join(dir,'receipt.json'),binaryPath=join(dir,name);
  for(const path of [dir,receiptPath,binaryPath]){
   const s=await lstat(path);if(s.isSymbolicLink()||(process.platform!=='win32'&&((s.mode&0o022)!==0||(process.getuid&&s.uid!==process.getuid()))))return null;
  }
  const receipt=JSON.parse((await readCachedFile(receiptPath,16*1024)).toString('utf8'));
  if(receipt.schema!==SCHEMA||receipt.repository!==REPOSITORY||receipt.tag!==tag||receipt.platform!==platform||receipt.name!==name||!/^[a-f0-9]{40}$/.test(receipt.source_sha)||!/^[a-f0-9]{64}$/.test(receipt.sha256)||!Number.isSafeInteger(receipt.size)||receipt.size<1||receipt.size>MAX_BINARY)return null;
  const s=await lstat(binaryPath);if(!s.isFile()||s.size!==receipt.size||(process.platform!=='win32'&&(s.mode&0o100)===0))return null;
  if(hash(await readCachedFile(binaryPath,MAX_BINARY))!==receipt.sha256)return null;
  return binaryPath;
 }catch{return null;}
}

async function readCachedFile(path,limit){
 // Never open a local FIFO/device or follow a cache file symlink. Check the
 // opened descriptor too, and bound reads even if the file changes in place.
 const before=await lstat(path);if(!before.isFile()||before.isSymbolicLink()||before.size>limit)throw fail();
 const file=await open(path,constants.O_RDONLY|(process.platform==='win32'?0:constants.O_NOFOLLOW|constants.O_NONBLOCK));
 try{
  const stat=await file.stat();if(!stat.isFile()||stat.size>limit||stat.ino!==before.ino||stat.dev!==before.dev)throw fail();
  const buffer=Buffer.alloc(stat.size+1),{bytesRead}=await file.read(buffer,0,buffer.length,0);
  if(bytesRead!==stat.size)throw fail();return buffer.subarray(0,bytesRead);
 }finally{await file.close();}
}

async function install({home,release,platform,arch,fetch}){
 const tag=release.tag;
 if(!/^(codex|claude)-v\d+\.\d+\.\d+$/.test(tag??''))throw fail();
 const target=platform+'-'+arch,name=names[target];
 if(!name)throw Object.assign(new Error(`Statewright has no native credential helper for ${target}. Use a supported platform; credentials will not be stored in plaintext.`),{code:'CREDENTIAL_HELPER_UNSUPPORTED'});
 const parent=await safeDirectory(home,['.statewright','helpers',tag]);
 const dir=join(parent,target),identity={tag,name,platform:target};
 try{const stat=await lstat(dir);if(!stat.isDirectory()||stat.isSymbolicLink())throw fail();}catch(e){if(e.code!=='ENOENT')throw e;}
 const cached=await cacheHit(dir,identity);if(cached)return cached;
 // One budget across metadata, redirects and binary streaming; redirects must
 // not reset the deadline or exhaust the native MCP startup window.
 const signal=AbortSignal.timeout(45_000);
 const [releaseBytes,commitBytes]=await Promise.all([download(`${API}/releases/tags/${tag}`,1024*1024,fetch,signal,true),download(`${API}/commits/${tag}`,1024*1024,fetch,signal,true)]);
 const metadata=JSON.parse(releaseBytes),commit=JSON.parse(commitBytes);
 if(metadata.tag_name!==tag||metadata.draft!==false||metadata.prerelease!==false||!metadata.published_at||!/^[a-f0-9]{40}$/.test(commit.sha??'')||!Array.isArray(metadata.assets))throw fail();
 const asset=assetName=>{
  const matches=metadata.assets.filter(a=>a.name===assetName);
  const a=matches[0];
  if(matches.length!==1||a.state!=='uploaded'||!Number.isSafeInteger(a.size)||a.size<1||a.size>MAX_BINARY||!/^sha256:[a-f0-9]{64}$/.test(a.digest??'')||a.browser_download_url!==`https://github.com/${REPOSITORY}/releases/download/${tag}/${assetName}`)throw fail();
  return a;
 };
 const manifestAsset=asset('credential-helper-release.json'),binaryAsset=asset(name);
 const manifestBytes=await download(manifestAsset.browser_download_url,128*1024,fetch,signal);
 if(hash(manifestBytes)!==manifestAsset.digest.slice(7)||manifestBytes.length!==manifestAsset.size)throw fail();
 const manifest=JSON.parse(manifestBytes),entry=manifest.assets?.[name];
 if(manifest.schema!==SCHEMA||manifest.repository!==REPOSITORY||manifest.tag!==tag||manifest.source_sha!==commit.sha||entry?.sha256!==binaryAsset.digest.slice(7)||entry.size!==binaryAsset.size)throw fail();
 const binary=await download(binaryAsset.browser_download_url,MAX_BINARY,fetch,signal);
 if(hash(binary)!==entry.sha256||binary.length!==entry.size)throw fail();
 const temp=await mkdtemp(join(parent,'.install-'));
 try{
  await writeFile(join(temp,name),binary,{mode:0o700,flag:'wx'});
  await writeFile(join(temp,'receipt.json'),JSON.stringify({schema:SCHEMA,repository:REPOSITORY,...identity,source_sha:commit.sha,sha256:entry.sha256,size:entry.size})+'\n',{mode:0o600,flag:'wx'});
  // An invalid prior cache is never executed or overwritten. Report it for
  // explicit recovery rather than following links or deleting user data.
  try{await rename(temp,dir);}catch(e){if(!['EEXIST','ENOTEMPTY'].includes(e.code)||!await cacheHit(dir,identity))throw e;}
  const result=await cacheHit(dir,identity);if(!result)throw fail();return result;
 }finally{await rm(temp,{recursive:true,force:true});}
}

export async function bootstrapCredentialHelper({home=homedir(),release,platform=process.platform,arch=process.arch,fetch=globalThis.fetch}={}){
 try{
  release??=await discoverHelperRelease();
  const key=join(home,release.tag??'',platform+'-'+arch);
  if(!inflight.has(key))inflight.set(key,install({home,release,platform,arch,fetch}).finally(()=>inflight.delete(key)));
  return await inflight.get(key);
 }catch(error){if(error.code==='CREDENTIAL_HELPER_UNSUPPORTED')throw error;throw fail();}
}
