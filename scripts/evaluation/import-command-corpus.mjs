// Download public text only. Fixture contents are never evaluated or executed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, realpath, stat, statfs, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const pages=['awk','cat','curl','docker-exec','find','git-diff','git-status','kubectl-get','kubectl-exec','npm-run',
  'python','rsync','sed','ssh','tar','tee','terraform-plan','wget','aws-s3-cp','rg'];

export async function boundedDownload(url,fetcher=fetch) {
  assert(new URL(url).protocol==='https:'&&['api.github.com','raw.githubusercontent.com'].includes(new URL(url).hostname));
  const response=await fetcher(url,{redirect:'error',signal:AbortSignal.timeout(30_000),headers:{Accept:'application/vnd.github+json','User-Agent':'statewright-static-benchmark'}});
  if(response.status===404)return null;
  assert(response.ok,`public download HTTP ${response.status}`);
  const chunks=[];let size=0;
  for await(const chunk of response.body) {
    size+=chunk.length;assert(size<=8*1024*1024,'source file exceeds eight MiB');chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function extractExamples(source,text) {
  if(source==='nl2bash')return text.split(/\r?\n/).filter(line=>line.trim());
  if(source==='tldr')return [...text.matchAll(/^`([^`\r\n]+)`\s*$/gm)].map(match=>match[1]);
  return [];
}

export async function importCorpus(root) {
  const sidecar=await realpath('/Volumes/sidecar');
  assert.notEqual((await stat(sidecar)).dev,(await stat('/Volumes')).dev,'Sidecar is not mounted');
  const space=await statfs(sidecar);assert(space.bavail*space.bsize>1024**3,'Sidecar has less than one GiB free');
  assert(root.startsWith(sidecar+'/') && !root.includes('/../'),'task root must be below mounted Sidecar');
  await mkdir(root,{mode:0o700}); // exclusive new task directory; no clobber/resume
  assert((await realpath(root)).startsWith(sidecar+'/'));
  const manifest={schema:'statewright/public-command-sources/v1',created_at:new Date().toISOString(),
    classification:'public_source_data',fixture_execution:'none',ground_truth:'none',sources:[],files:[],unavailable:[],historical:[]};
  const cases=[];
  async function store(repo,revision,path,source,license) {
    const url=`https://raw.githubusercontent.com/${repo}/${revision}/${path}`;
    const bytes=await boundedDownload(url);
    if(!bytes){assert(path.startsWith('pages/'),'required corpus or license file missing');manifest.unavailable.push({repo,revision,path,status:404});return;}
    const destination=join(root,repo.replace('/','__'),path);
    await mkdir(join(destination,'..'),{recursive:true});
    await writeFile(destination,bytes,{flag:'wx',mode:0o600});
    const entry={repo,revision,path,url,license,sha256:hash(bytes),bytes:bytes.length};manifest.files.push(entry);
    if(path==='data/bash/all.cm'||source==='tldr'&&path.startsWith('pages/')) {
      extractExamples(source,bytes.toString('utf8')).forEach((command,index)=>cases.push({
        id:hash(`${repo}\n${revision}\n${path}\n${index}\n${command}`),source,repo,revision,path,index,command,
        placeholders:source==='tldr',label_status:'unclassified',source_sha256:entry.sha256,license}));
    }
  }
  for(const [repo,branch,license,source,paths] of [
    ['TellinaTool/nl2bash','master','MIT-dataset','nl2bash',['data/bash/LICENSE','data/bash/all.cm','data/bash/all.nl']],
    ['tldr-pages/tldr','main','CC-BY-4.0-pages','tldr',['LICENSE.md',...pages.map(page=>`pages/common/${page}.md`)]],
    ['mvdan/sh','master','BSD-3-Clause','syntax',['LICENSE','syntax/filetests_test.go']],
  ]) {
    const metadata=JSON.parse((await boundedDownload(`https://api.github.com/repos/${repo}/commits/${branch}`)).toString('utf8'));
    assert(/^[a-f0-9]{40}$/.test(metadata.sha),'missing immutable revision');
    manifest.sources.push({repo,revision:metadata.sha,branch,license});
    for(const path of paths)await store(repo,metadata.sha,path,source,license);
  }
  // Only fixed read-only Git calls inspect our own historical classifier. No
  // repository hooks or fixture commands run; the bytes remain benchmark data.
  for(const revision of ['0d4ad8fc3a89c078a1364a47f380a476846b4f36','0342bb86726d234cde0985ad915585bcc3d71354']) {
    const path='crates/mcp-gateway/src/bash_classifier.rs';
    const bytes=execFileSync('git',['show',`${revision}:${path}`],{maxBuffer:2*1024*1024});
    const blob=execFileSync('git',['rev-parse',`${revision}:${path}`],{encoding:'utf8'}).trim();
    await writeFile(join(root,`historical-${revision}.rs.txt`),bytes,{flag:'wx',mode:0o600});
    manifest.historical.push({revision,path,blob,sha256:hash(bytes),bytes:bytes.length});
  }
  const corpus=Buffer.from(cases.map(row=>JSON.stringify(row)).join('\n')+'\n');
  await writeFile(join(root,'commands.jsonl'),corpus,{flag:'wx',mode:0o600});
  manifest.command_count=cases.length;manifest.corpus_sha256=hash(corpus);
  await writeFile(join(root,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({root,commands:cases.length,files:manifest.files.length,unavailable:manifest.unavailable.length,corpus_sha256:manifest.corpus_sha256}));
  return manifest;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length,3,'expected new Sidecar output directory');
  await importCorpus(process.argv[2]);
}
