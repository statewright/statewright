import {createHash} from 'node:crypto';
import {lstat,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const HELPER_ASSETS=['statewright-credentials-linux-x64','statewright-credentials-darwin-arm64','statewright-credentials-darwin-x64','statewright-credentials-windows-x64.exe'];
export async function packageCredentialHelpers({directory,tag,sourceSha,check=false}){
 if(!/^(codex|claude)-v\d+\.\d+\.\d+$/.test(tag??'')||!/^[a-f0-9]{40}$/.test(sourceSha??''))throw Error('Exact numeric release tag and source SHA required');
 const assets={};
 for(const name of HELPER_ASSETS){
  const path=join(directory,'bin',name),stat=await lstat(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>32*1024*1024)throw Error('Invalid helper asset: '+name);
  const bytes=await readFile(path);assets[name]={sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length};
 }
 const manifest={schema:'statewright/credential-helper-release/v1',repository:'statewright/statewright',tag,source_sha:sourceSha,assets};
 const manifestPath=join(directory,'bin','credential-helper-release.json'),serialized=JSON.stringify(manifest,null,2)+'\n';
 if(check){if(await readFile(manifestPath,'utf8')!==serialized)throw Error('Helper release manifest does not match the exact source and asset bytes');}
 else await writeFile(manifestPath,serialized);
 return manifest;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [directory,tag,sourceSha,mode]=process.argv.slice(2);
 if(mode&&mode!=='--check')throw Error('Unsupported helper manifest mode');
 await packageCredentialHelpers({directory,tag,sourceSha,check:mode==='--check'});
}
