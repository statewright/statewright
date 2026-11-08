// Read-only history mining. Raw history is never copied or sent to a model.
import assert from 'node:assert/strict';
import {createReadStream} from 'node:fs';
import {mkdir,readFile,readdir,realpath,stat,writeFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const sha=value=>createHash('sha256').update(value).digest('hex');
const sensitive=/(?:api[_. -]?key|access[_. -]?key|secret|password|passwd|passphrase|authorization|bearer|credential|private[_. -]?key|client[_. -]?secret|refresh[_. -]?token|access[_. -]?token|id[_. -]?token|session[_. -]?token|token=|--token\b|--key\b|--password\b|--pass\b|--auth\b|gopass|keychain|security\s+find|printenv|\.env\b|\.ssh\b|\.aws\b|\.npmrc\b|\.netrc\b|\.pypirc\b|\.pem\b|\.key\b|BEGIN [A-Z ]*PRIVATE KEY|(?:^|\s)(?:login|auth)(?:\s|$))/i;

export function sanitize(command) {
  if(typeof command!=='string'||!command.trim())return {skip:'empty'};
  if(command.length>1200||/[\r\n\uFFFD]/.test(command))return {skip:'multiline_oversized_or_encoding'};
  if(sensitive.test(command))return {skip:'sensitive_context'};
  if(/\b(?:cat|rg|grep|sed|head|tail|less|more|cp|scp)\b.*\.kube\//.test(command))return {skip:'credential_file_content'};
  if(/(?:^|[\s;&|])[A-Za-z_][A-Za-z0-9_]*=/.test(command))return {skip:'assignment_value'};
  if(/\bsshpass\b|\b(?:mysql|mysqldump)\b.*\s-p|\bcurl\b.*(?:\s-u\b|--user\b|--proxy-user\b)/.test(command))return {skip:'credential_client'};
  if(/\b(?:curl|wget|http)\b.*(?:--cookie\b|--cookies\b|(?:^|\s)-b(?:\s|[^\s])|--header\b|(?:^|\s)-H(?:\s|[^\s])|--post-file\b|--config\b|(?:^|\s)-K(?:\s|[^\s]))/.test(command))return {skip:'opaque_request_context'};
  if(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/"']*@/i.test(command))return {skip:'credential_uri'};
  if(/https?:\/\/[^\s"']*[?@]/i.test(command)||/\b(?:sk-|gh[pousr]_|github_pat_|AIza|AKIA|ASIA|eyJ)[A-Za-z0-9_./+=-]{8,}/.test(command))return {skip:'credential_or_url_payload'};
  // Opaque long values may be keys even without a revealing option name.
  if(/(?:^|[\s="'])[^\s"'`/]{28,}(?=$|[\s"'`])/.test(command))return {skip:'opaque_long_value'};
  if(/(?:^|[\s="'`])[A-Za-z0-9_+/=-]{28,}(?=$|[\s"'`])/.test(command))return {skip:'opaque_encoded_value'};
  // Omit payload/file dumps and orchestration strings we cannot safely inspect.
  if(/\b(?:curl|wget|http)\b.*(?:--data|-d\b|--upload|--form|-F\b)/.test(command))return {skip:'request_payload'};
  const changes=[];
  let result=command.trim();
  const replace=(pattern,value,reason)=>{if(pattern.test(result)){result=result.replace(pattern,value);changes.push(reason);}};
  replace(/\/Users\/ben\b/g,'/fixture/home','home_path');
  replace(/\/Volumes\/sidecar\b/g,'/fixture/sidecar','sidecar_path');
  replace(/https?:\/\/[^\s"'<>]+/g,'https://fixture.invalid/resource','url_target');
  replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,'user@fixture.invalid','email_identity');
  if(sensitive.test(result))return {skip:'sensitive_after_redaction'};
  return {command:result,redactions:changes,evidence_loss:changes.length>0};
}

export function zshCommands(text) {
  const lines=text.split(/\r?\n/),extended=lines.some(line=>/^: \d+:\d+;/.test(line));
  if(!extended)return lines.map((command,index)=>({command,line:index+1}));
  const rows=[];let pending=null;
  for(let index=0;index<lines.length;index++) {
    const match=lines[index].match(/^: \d+:\d+;(.*)$/);
    if(match){if(pending)rows.push(pending);pending={command:match[1],line:index+1};}
    else if(pending&&lines[index])pending.command+='\n'+lines[index];
  }
  if(pending)rows.push(pending);return rows;
}

export function eventCommands(event) {
  const result=[];
  const add=(name,input)=>{
    if(!['Bash','bash','shell','exec_command','functions.exec_command'].includes(name))return;
    if(typeof input==='string'){try{input=JSON.parse(input);}catch{return;}}
    const command=input?.cmd??input?.command;
    if(typeof command==='string')result.push(command);
  };
  const payload=event.type==='response_item'?event.payload:event;
  if(payload?.type==='function_call')add(payload.name,payload.arguments);
  for(const block of Array.isArray(event.message?.content)?event.message.content:[])if(block.type==='tool_use')add(block.name,block.input);
  return result;
}

// Parse orchestration as data, never execute it. A literal call is only a proposed
// invocation: control flow and actual dispatch are deliberately not inferred.
export function orchestrationCommands(source,parse) {
  if(typeof source!=='string'||source.length>512*1024)return [];
  let ast;try{ast=parse(source,{ecmaVersion:'latest',sourceType:'module',allowAwaitOutsideFunction:true,allowReturnOutsideFunction:true});}catch{return [];}
  const commands=[];
  const visit=node=>{
    if(!node||typeof node!=='object')return;
    if(node.type==='CallExpression'&&node.callee?.type==='MemberExpression'&&!node.callee.computed&&
      node.callee.object?.name==='tools'&&node.callee.property?.name==='exec_command'&&node.arguments[0]?.type==='ObjectExpression') {
      const properties=node.arguments[0].properties;
      // Spreads, computed keys and duplicate fields can replace the apparent cmd.
      if(properties.every(p=>p.type==='Property'&&!p.computed&&p.kind==='init')) {
        const fields=properties.filter(p=>['cmd','command'].includes(p.key.name??p.key.value));
        if(fields.length===1) {
          const value=fields[0].value;
          if(value.type==='Literal'&&typeof value.value==='string')commands.push(value.value);
          else if(value.type==='TemplateLiteral'&&value.expressions.length===0)commands.push(value.quasis[0].value.cooked);
        }
      }
    }
    for(const value of Object.values(node))if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);
  };
  visit(ast);return commands.filter(value=>typeof value==='string');
}

export function orchestrationEventCommands(event,parse) {
  const payload=event.type==='response_item'?event.payload:null;
  if(!['function_call','custom_tool_call'].includes(payload?.type)||!['exec','functions.exec'].includes(payload?.name))return null;
  return orchestrationCommands(payload.type==='custom_tool_call'?payload.input:payload.arguments,parse);
}

async function loadParser() {
  for(const path of ['/Users/ben/dev/auldwyrm/site/node_modules/acorn/dist/acorn.mjs','/Users/ben/dev/polyhedron/node_modules/acorn/dist/acorn.mjs']) {
    try{const bytes=await readFile(path),module=await import(pathToFileURL(path).href);return {parse:module.parse,identity:{name:'acorn',version:module.version,sha256:sha(bytes)}};}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  throw new Error('Existing local Acorn parser required; no dependency installation or eval fallback');
}

async function jsonlFiles(root,limit=4000) {
  const files=[],queue=[{path:root,depth:0}];let visited=0;
  while(queue.length&&visited<limit) {
    const current=queue.shift();
    let entries;try{entries=await readdir(current.path,{withFileTypes:true});}catch{continue;}
    for(const entry of entries.sort((a,b)=>b.name.localeCompare(a.name))) {
      if(++visited>limit)break;
      const path=join(current.path,entry.name);
      if(entry.isDirectory()&&current.depth<4)queue.push({path,depth:current.depth+1});
      else if(entry.isFile()&&entry.name.endsWith('.jsonl')){const info=await stat(path);files.push({path,size:info.size,mtime:info.mtimeMs});}
    }
  }
  return {files:files.sort((a,b)=>b.mtime-a.mtime).slice(0,32),discovery_limited:visited>=limit};
}

export async function mineHistory(output) {
  assert(resolve(output).startsWith('/Volumes/sidecar/'),'mounted Sidecar output required');
  assert.notEqual((await stat('/Volumes/sidecar')).dev,(await stat('/')).dev,'Sidecar is not mounted');
  await mkdir(output,{mode:0o700}); // Exclusive directory: do not replace prior data.
  const counts={skips:{},accepted_by_source:{},duplicates:0,jsonl_parse_failures:0,unsupported_orchestrators:0},rows=[],seen=new Set(),families=new Map();
  const sourceRoots=[],seenRoots=new Set(),parser=await loadParser();
  const accept=(command,kind,sourceId,line)=>{
    const clean=sanitize(command);
    if(clean.skip){counts.skips[clean.skip]=(counts.skips[clean.skip]??0)+1;return;}
    const id=sha(clean.command);
    if(seen.has(id)){counts.duplicates++;return;}
    const family=clean.command.split(/\s+/)[0],familyKey=kind+'/'+family;
    if((families.get(familyKey)??0)>=20){counts.skips.family_cap=(counts.skips.family_cap??0)+1;return;}
    if(rows.length>=900){counts.skips.sample_cap=(counts.skips.sample_cap??0)+1;return;}
    if((counts.accepted_by_source[kind]??0)>=300){counts.skips.source_cap=(counts.skips.source_cap??0)+1;return;}
    seen.add(id);families.set(familyKey,(families.get(familyKey)??0)+1);
    rows.push({id,command:clean.command,kind,source_id:sourceId,line,redactions:clean.redactions,evidence_loss:clean.evidence_loss,label_status:'unclassified_private_sanitized'});
    counts.accepted_by_source[kind]=(counts.accepted_by_source[kind]??0)+1;
  };
  const history='/Users/ben/.zsh_history',historyInfo=await stat(history);
  assert(historyInfo.size<=1024*1024,'history exceeds bounded read');
  for(const row of zshCommands(await readFile(history,'utf8')).reverse())accept(row.command,'zsh',sha(history),row.line);
  for(const [kind,root]of [
    ['codex_jsonl','/Users/ben/.codex/sessions'],
    ['codex_jsonl','/Users/ben/.statewright/lanes/staging/codex-homes/0.3.5+codex.20261018180000/sessions'],
    ['claude_jsonl','/Users/ben/.claude/projects'],
  ]) {
    let resolved;try{resolved=await realpath(root);}catch{continue;}
    if(seenRoots.has(resolved))continue;seenRoots.add(resolved);
    const discovered=await jsonlFiles(resolved),summary={kind,root_id:sha(resolved),files:discovered.files.length,discovery_limited:discovered.discovery_limited,tail_bytes:4*1024*1024};sourceRoots.push(summary);
    for(const file of discovered.files) {
      if(!file.size)continue;
      const start=Math.max(0,file.size-4*1024*1024),stream=createReadStream(file.path,{start,end:file.size-1}),lines=createInterface({input:stream,crlfDelay:Infinity});
      let line=0;
      for await(const text of lines) {
        line++;if(start>0&&line===1)continue;
        if(text.length>512*1024){counts.skips.oversized_jsonl_record=(counts.skips.oversized_jsonl_record??0)+1;continue;}
        let event;try{event=JSON.parse(text);}catch{counts.jsonl_parse_failures++;continue;}
        const commands=orchestrationEventCommands(event,parser.parse);
        if(commands!==null) {
          if(!commands.length)counts.unsupported_orchestrators++;
          for(const command of commands)accept(command,'codex_orchestrator_literal',sha(file.path),line);
        }
        for(const command of eventCommands(event))accept(command,kind,sha(file.path),line);
      }
    }
  }
  const bytes=rows.map(row=>JSON.stringify(row)).join('\n')+'\n';
  await writeFile(join(output,'candidates.jsonl'),bytes,{flag:'wx',mode:0o600});
  const manifest={schema:'statewright/private-history-mining/v1',classification:'private_sanitized_local_only',created_at:new Date().toISOString(),
    fixture_execution:'none',raw_history_persisted:false,selection:'Recent zsh records plus bounded recent Codex/Claude JSONL tails, deduplicated sanitized strings and per-source family cap20. Not representative.',
    skipped:'Credential-like context/values, HTTP payloads, multiline/large/encoding-invalid commands. Orchestrator code is parsed, never evaluated; only literal tools.exec_command object fields are extracted. Dispatch is not proven.',
    orchestration_parser:parser.identity,
    candidates:rows.length,candidates_sha256:sha(bytes),sourceRoots,counts};
  await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
  return manifest;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)console.log(JSON.stringify(await mineHistory(process.argv[2])));
