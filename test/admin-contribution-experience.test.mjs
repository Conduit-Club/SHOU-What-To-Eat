import test from 'node:test';
import assert from 'node:assert/strict';
import { adminSessionState, contributionCapabilities, loginHref } from '../src/utils/auth-session.ts';

const user={username:'本地管理员',picture:null,isAdmin:true,wasAdmin:true,adminExpiresAt:2000,expiresAt:8000};

test('admin display expires on the claimed deadline without a new SQL read and keeps ordinary direct contributions available',()=>{
  assert.equal(adminSessionState(user,1000),'active');
  assert.equal(adminSessionState(user,1940),'expiring');
  assert.equal(adminSessionState(user,2000),'expired');
  assert.equal(adminSessionState({...user,isAdmin:false},1000),'expired');
  assert.equal(adminSessionState(null,1000),'none');
  assert.deepEqual(contributionCapabilities({user,directPublishing:true},1000),{direct:true,adminDirect:true,adminState:'active'});
  assert.deepEqual(contributionCapabilities({user,directPublishing:true},2000),{direct:true,adminDirect:false,adminState:'expired'});
  assert.equal(contributionCapabilities({user,directPublishing:true},8000).direct,false);
  assert.equal(contributionCapabilities({user,directPublishing:false},1000).adminDirect,false);
  assert.equal(contributionCapabilities({user:{...user,isAdmin:false,wasAdmin:false},directPublishing:true},1000).adminDirect,false);
});

test('renewal returns to the current local form including filters and anchor',()=>{
  const target='/submit/?venueEntityId=local-venue#receipt-panel';
  assert.equal(new URL('https://eat.shoumc.com'+loginHref(target)).searchParams.get('returnTo'),target);
});
