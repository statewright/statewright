import {execFileSync} from 'node:child_process';
import {lstatSync,readFileSync,readlinkSync} from 'node:fs';
import {resolve} from 'node:path';

const forbidden=[['ni','nfer'],['30','90'],['olla','ma-casa'],['wey','oun'],['cor','tana'],['andu','ril'],['ae','rith'],['/Users/','ben'],['auld','wyrm']].map(parts=>parts.join('').toLowerCase());
const publicHosts=new Set(['glitch.enhasa.cloud','umami.enhasa.cloud']);

// Scan bytes even for binary files: a NUL must not hide a private ASCII value.
// Findings identify the rule and path, never echo matched payloads.
export function publicSourceViolations(path,bytes){
 const text=(path+'\n'+Buffer.from(bytes).toString('utf8')).toLowerCase();
 const findings=forbidden.filter(term=>text.includes(term)).map((_,index)=>({path,rule:'private-term',index}));
 for(const match of text.matchAll(/\b([a-z0-9.-]+\.enhasa\.cloud)\b/g))if(!publicHosts.has(match[1]))findings.push({path,rule:'private-host'});
 return findings;
}

export function scanTrackedPublicSources(root,{read=path=>{
 const info=lstatSync(path);
 if(info.isSymbolicLink())return Buffer.from(readlinkSync(path));
 if(!info.isFile())throw Error('Tracked source is not a regular file: '+path);
 return readFileSync(path);
},entries,reviewedGitlinks={}}={}){
 const rows=entries??execFileSync('git',['ls-files','--stage','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
 const findings=[];
 for(const row of rows){
  const match=row.match(/^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/);
  if(!match||match[3]!=='0')throw Error('Unreviewed tracked Git entry');
  const path=match[4];
  if(match[1]==='160000'&&reviewedGitlinks[path]===match[2]){
   findings.push(...publicSourceViolations(path,match[2]));continue;
  }
  if(!['100644','100755','120000'].includes(match[1]))throw Error('Unreviewed tracked Git entry: '+path);
  // Read errors intentionally fail the gate; do not silently omit source files.
  findings.push(...publicSourceViolations(path,read(resolve(root,path))));
 }
 return findings;
}
