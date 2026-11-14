import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

for(const client of ['codex','claude-code']) test(`${client}: palette rejection cannot invalidate gateway credentials`,()=>{
 const source=readFileSync(resolve(`plugins/${client}/mcp-proxy.sh`),'utf8');
 const names=['key_fingerprint','invalid_key_matches','client_tools_rejection_matches','mark_client_tools_rejected','upload_client_tools'];
 const definitions=names.map(name=>{
  const start=source.indexOf(name+'() {');assert.ok(start>=0,name);
  return source.slice(start,source.indexOf('\n}',start)+2);
 }).join('\n');
 const dir=mkdtempSync(join(tmpdir(),'sw-palette-scope-'));
 try{
  mkdirSync(join(dir,'home'));mkdirSync(join(dir,'bin'));
  writeFileSync(join(dir,'bin','curl'),`#!/usr/bin/env bash
out=''
while [ $# -gt 0 ]; do
 if [ "$1" = '-o' ]; then out="$2"; shift; fi
 shift
done
printf 'x' >> "$CURL_COUNT"
printf '{"error":"invalid_api_key"}' > "$out"
printf '401'
`,{mode:0o700});
  const script=`${definitions}
STATEWRIGHT_DIR="$HOME/.statewright"
INVALID_KEY_SENTINEL="$STATEWRIGHT_DIR/invalid_api_key"
PB_URL=https://app.example
mark_invalid_key() { echo 'GLOBAL INVALIDATION CALLED' >&2; exit 88; }
upload_client_tools sw_live_SYNTHETIC_A
[ ! -f "$INVALID_KEY_SENTINEL" ] || exit 10
invalid_key_matches sw_live_SYNTHETIC_A && exit 11
client_tools_rejection_matches sw_live_SYNTHETIC_A || exit 12
upload_client_tools sw_live_SYNTHETIC_A
[ "$(wc -c < "$CURL_COUNT" | tr -d ' ')" = 1 ] || exit 13
upload_client_tools sw_live_SYNTHETIC_B
[ "$(wc -c < "$CURL_COUNT" | tr -d ' ')" = 2 ] || exit 14
PB_URL=https://other.example
upload_client_tools sw_live_SYNTHETIC_B
[ "$(wc -c < "$CURL_COUNT" | tr -d ' ')" = 3 ] || exit 15
# Existing global rejection remains authoritative and independent.
printf '%s\\n' "$(key_fingerprint sw_live_SYNTHETIC_A)" > "$INVALID_KEY_SENTINEL"
invalid_key_matches sw_live_SYNTHETIC_A || exit 16
invalid_key_matches sw_live_SYNTHETIC_B && exit 17
exit 0
`;
  const result=spawnSync('bash',['-c',script],{cwd:dir,env:{...process.env,LC_ALL:'C',LANG:'C',HOME:join(dir,'home'),PATH:join(dir,'bin')+':'+process.env.PATH,CURL_COUNT:join(dir,'calls')},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const restarted=spawnSync('bash',['-c',definitions+`\nINVALID_KEY_SENTINEL="$HOME/.statewright/invalid_api_key"; PB_URL=https://other.example; client_tools_rejection_matches sw_live_SYNTHETIC_B`],{env:{...process.env,LC_ALL:'C',LANG:'C',HOME:join(dir,'home')},encoding:'utf8'});
  assert.equal(restarted.status,0,'palette rejection must survive a fresh proxy process');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
