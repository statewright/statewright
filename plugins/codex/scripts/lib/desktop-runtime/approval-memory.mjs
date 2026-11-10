import {createHash, createHmac, randomBytes, randomUUID, timingSafeEqual} from "node:crypto";
import {constants} from "node:fs";
import {mkdir, open, readdir, rename, unlink, rm} from "node:fs/promises";
import {join} from "node:path";

export const APPROVAL_DURATIONS = Object.freeze(["once", "2h", "4h", "8h", "always"]);
const TTL = {"2h": 2*3600_000, "4h": 4*3600_000, "8h": 8*3600_000, always: null};
const hex = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function approvalMemoryContext(value) {
  if (value?.schema !== "statewright/approval-memory-context/v1"
      || !["policy_sha256", "invocation_sha256", "dependency_sha256"].every(key=>hex(value[key]))
      || typeof value.reusable !== "boolean" || !Array.isArray(value.allowed_durations)
      || !value.allowed_durations.length || value.allowed_durations.some(v=>!APPROVAL_DURATIONS.includes(v))
      || (value.approve_for !== undefined && (!APPROVAL_DURATIONS.includes(value.approve_for)
        || (value.approve_for !== "once" && !value.allowed_durations.includes(value.approve_for))))) return null;
  return {schema:value.schema, policy_sha256:value.policy_sha256,
    invocation_sha256:value.invocation_sha256, dependency_sha256:value.dependency_sha256,
    reusable:value.reusable, approve_for:value.approve_for ?? "once",
    allowed_durations:APPROVAL_DURATIONS.filter(v=>v==="once"||value.allowed_durations.includes(v))};
}
function identity(binding) {
  if (!binding || !["policy_sha256","invocation_sha256","dependency_sha256"].every(k=>hex(binding[k]))) {
    throw new Error("approval_memory_binding_unavailable");
  }
  return JSON.stringify([binding.policy_sha256,binding.invocation_sha256,binding.dependency_sha256]);
}

/** Private local grants. A grant never authorizes a tool by itself: the native
 * controller supplies current gateway clearance and verifies its live owner. */
export class ApprovalMemory {
  constructor({root, namespace, now=Date.now}) {
    if (typeof root!=="string"||!root||typeof namespace!=="string"||!namespace) throw new Error("approval_memory_scope_unavailable");
    this.root=join(root,createHash("sha256").update(namespace).digest("hex"));
    this.now=now;
  }
  async read(path, max=16384) {
    const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try {
      const stat=await file.stat();
      if (!stat.isFile()||stat.size>max||process.platform!=="win32"&&(stat.mode&0o077)!==0) throw new Error("approval_memory_file_invalid");
      const bytes=await file.readFile();if(bytes.length>max)throw new Error("approval_memory_file_invalid");
      return bytes;
    } finally {await file.close();}
  }
  async key() {
    await mkdir(this.root,{recursive:true,mode:0o700});
    const path=join(this.root,"key");
    try {
      const file=await open(path,"wx",0o600);
      try {await file.writeFile(randomBytes(32));await file.sync();}finally{await file.close();}
    }catch(error){if(error.code!=="EEXIST")throw error;}
    const key=await this.read(path,32);if(key.length!==32)throw new Error("approval_memory_key_invalid");return key;
  }
  mac(key,value){return createHmac("sha256",key).update(value).digest("hex");}
  async locked(operation) {
    // Same unique-ticket bakery protocol as Desktop setup. A dead owner's
    // unique ticket can be removed without racing a new owner's lock file.
    const queue=join(this.root,"queue");await mkdir(queue,{recursive:true,mode:0o700});
    const name=`${process.pid}-${randomUUID()}`,ticket=join(queue,name);await mkdir(ticket,{mode:0o700});
    const publish=async value=>{const temporary=join(ticket,randomUUID());const file=await open(temporary,"wx",0o600);
      try{await file.writeFile(JSON.stringify(value));}finally{await file.close();}await rename(temporary,join(ticket,"owner"));};
    const tickets=async()=>{const values=[];for(const entry of await readdir(queue,{withFileTypes:true})){
      if(!entry.isDirectory()||!/^\d+-[a-f0-9-]{36}$/.test(entry.name))throw new Error("approval_memory_lock_invalid");
      const pid=Number(entry.name.split("-",1)[0]);let dead=false;
      try{process.kill(pid,0);}catch(error){dead=error.code==="ESRCH";}
      const path=join(queue,entry.name);if(dead){await rm(path,{recursive:true,force:true});continue;}
      let owner;try{owner=JSON.parse(await this.read(join(path,"owner"),2048));}catch(error){if(error.code!=="ENOENT")throw error;}
      values.push({name:entry.name,owner});
    }return values;};
    try{
      await publish({choosing:true,number:0});const initial=await tickets();
      const number=1+Math.max(0,...initial.map(t=>Number.isSafeInteger(t.owner?.number)?t.owner.number:0));
      if(!Number.isSafeInteger(number))throw new Error("approval_memory_lock_invalid");
      await publish({choosing:false,number});const deadline=Date.now()+2000;
      for(;;){const active=await tickets(),self=active.find(t=>t.name===name);
        if(self?.owner?.number!==number||self.owner.choosing)throw new Error("approval_memory_lock_lost");
        const blocked=active.some(t=>t.name!==name&&(!t.owner||t.owner.choosing||!Number.isSafeInteger(t.owner.number)
          ||t.owner.number<number||t.owner.number===number&&t.name<name));
        if(!blocked)return await operation(await this.key());
        if(Date.now()>=deadline)throw new Error("approval_memory_busy");
        await new Promise(resolve=>setTimeout(resolve,10));
      }
    }finally{await rm(ticket,{recursive:true,force:true});}
  }
  async load(key,id) {
    let bytes;try{bytes=await this.read(join(this.root,id+".json"));}catch(error){if(error.code==="ENOENT")return null;throw error;}
    const envelope=JSON.parse(bytes);const grant=envelope?.grant;
    if (!grant||grant.schema!=="statewright/approval-memory-grant/v1"||grant.id!==id
        || !hex(grant.binding_sha256)||!Object.hasOwn(TTL,grant.duration)||typeof grant.generation!=="string"
        || !/^[a-f0-9-]{36}$/.test(grant.generation)
        || !Number.isSafeInteger(grant.issued_at)||!Number.isSafeInteger(grant.last_used_at)
        || grant.issued_at<0||grant.last_used_at<grant.issued_at
        || (grant.duration==="always"?grant.expires_at!==null:grant.expires_at!==grant.issued_at+TTL[grant.duration])
        || !hex(envelope.mac)||!timingSafeEqual(Buffer.from(envelope.mac,"hex"),Buffer.from(this.mac(key,JSON.stringify(grant)),"hex"))) {
      throw new Error("approval_memory_record_invalid");
    }
    return grant;
  }
  async save(key,grant) {
    const path=join(this.root,grant.id+".json"),temporary=path+"."+randomUUID();let file;
    try{
      file=await open(temporary,"wx",0o600);
      await file.writeFile(JSON.stringify({grant,mac:this.mac(key,JSON.stringify(grant))}));await file.sync();await file.close();file=null;
      await rename(temporary,path);
      if(process.platform!=="win32"){const directory=await open(this.root,"r");try{await directory.sync();}finally{await directory.close();}}
    }finally{await file?.close();await unlink(temporary).catch(error=>{if(error.code!=="ENOENT")throw error;});}
  }
  async lookup(binding) {
    const value=identity(binding);
    return this.locked(async key=>{
      const id=this.mac(key,value),grant=await this.load(key,id),now=this.now();
      if(!grant||grant.binding_sha256!==id||now<grant.last_used_at||grant.expires_at!==null&&now>=grant.expires_at)return null;
      grant.last_used_at=now;await this.save(key,grant);return grant;
    });
  }
  async remember(binding,duration) {
    const value=identity(binding);if(!Object.hasOwn(TTL,duration))throw new Error("approval_memory_duration_invalid");
    return this.locked(async key=>{
      const now=this.now(),id=this.mac(key,value);
      const grant={schema:"statewright/approval-memory-grant/v1",id,binding_sha256:id,generation:randomUUID(),duration,issued_at:now,last_used_at:now,
        expires_at:TTL[duration]===null?null:now+TTL[duration]};
      await this.save(key,grant);return grant;
    });
  }
  async confirm(binding,expected) {
    const value=identity(binding);
    return this.locked(async key=>{
      const id=this.mac(key,value),grant=await this.load(key,id),now=this.now();
      return !!grant&&grant.id===expected.id&&grant.generation===expected.generation
        &&now>=grant.last_used_at&&(grant.expires_at===null||now<grant.expires_at);
    });
  }
  async list() {
    return this.locked(async key=>{
      const names=(await readdir(this.root)).filter(name=>/^[a-f0-9]{64}\.json$/.test(name));
      if(names.length>4096)throw new Error("approval_memory_record_limit");
      const grants=[];for(const name of names){const grant=await this.load(key,name.slice(0,-5));
        if(grant&&this.now()>=grant.last_used_at&&(grant.expires_at===null||this.now()<grant.expires_at)){
          const {binding_sha256,...display}=grant;grants.push(display);
        }}return grants;
    });
  }
  async revoke(id) {
    if(id!=="all"&&!hex(id))throw new Error("approval_memory_id_invalid");
    return this.locked(async()=>{
      const names=id==="all"?(await readdir(this.root)).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)):[id+".json"];
      for(const name of names)await unlink(join(this.root,name)).catch(error=>{if(error.code!=="ENOENT")throw error;});
      if(process.platform!=="win32"){const directory=await open(this.root,"r");try{await directory.sync();}finally{await directory.close();}}
      return {revoked:id};
    });
  }
}
