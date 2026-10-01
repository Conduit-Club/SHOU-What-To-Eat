import {createHmac,createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';

const secret=process.env.DEPLOY_WEBHOOK_SECRET;
if(!secret)throw new Error('Backup authentication is not configured');
const origin=process.env.CATALOG_ORIGIN||'https://eat.shoumc.com';
async function request(path,method='GET',data){
  const body=data?JSON.stringify(data):'',timestamp=String(Date.now());
  const signature=createHmac('sha256',secret).update(`backup-v1\n${timestamp}\n${method}\n${path}\n${body}`).digest('hex');
  const response=await fetch(origin+path,{method,headers:{'Content-Type':'application/json','X-Backup-Timestamp':timestamp,'X-Backup-Signature':signature},...(body?{body}:{}),signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error(`Backup endpoint returned ${response.status}`);
  return response.json();
}
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
const exported=await request('/api/v2/backup/export');
if(createHash('sha256').update(JSON.stringify(exported.snapshot)).digest('hex')!==exported.contentHash)throw new Error('Snapshot hash mismatch');
// This is an isolated backup branch, never a code or production content input.

const remote=git('ls-remote','--heads','origin','data-backup');
if(remote){git('fetch','origin','data-backup');git('checkout','-B','data-backup','origin/data-backup');}
else {git('checkout','--orphan','data-backup');git('rm','-r','--cached','.');}
await mkdir('backups',{recursive:true});
await writeFile('backups/catalog.json',JSON.stringify(exported.snapshot,null,2)+'\n');
await writeFile('backups/manifest.json',JSON.stringify({revision:exported.snapshot.revision,contentHash:exported.contentHash,scope:'Canonical released content and archived revisions; R2 image bytes remain in Cloudflare.'},null,2)+'\n');
git('add','backups/catalog.json','backups/manifest.json');
if(git('diff','--cached','--name-only')){
  git('config','user.name','github-actions[bot]');git('config','user.email','41898282+github-actions[bot]@users.noreply.github.com');
  git('commit','-m',`backup: Cloudflare catalog revision ${exported.snapshot.revision}`);
  git('push','origin','HEAD:refs/heads/data-backup');
}
await request('/api/v2/backup/ack','POST',{revision:exported.snapshot.revision,contentHash:exported.contentHash,commit:git('rev-parse','HEAD')});
console.log(`Backed up catalog revision ${exported.snapshot.revision}`);
