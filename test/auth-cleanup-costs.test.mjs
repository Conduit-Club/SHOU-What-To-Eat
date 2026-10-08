import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {EXPIRED_LOGIN_SQL,EXPIRED_SESSION_SQL} from '../src/worker/auth.ts';
test('bounded expiry cleanup uses existing primary keys and preserves live records',()=>{
 const db=new DatabaseSync(':memory:');
 try{
 db.exec(`CREATE TABLE auth_login_transactions(state_hash TEXT PRIMARY KEY,expires_at INTEGER); CREATE INDEX auth_login_transactions_expiry ON auth_login_transactions(expires_at);
 CREATE TABLE auth_sessions(token_hash TEXT PRIMARY KEY,expires_at INTEGER); CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);
 WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000) INSERT INTO auth_login_transactions SELECT CAST(x AS TEXT),10000 FROM n;
 WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<60) INSERT INTO auth_sessions SELECT CAST(x AS TEXT),CASE WHEN x<=55 THEN 1 ELSE 10000 END FROM n;`);
 for(const sql of [EXPIRED_LOGIN_SQL,EXPIRED_SESSION_SQL]){
 const plan=db.prepare('EXPLAIN QUERY PLAN '+sql).all(500).map(row=>row.detail).join('\n');
 assert.match(plan,/SEARCH .* USING COVERING INDEX sqlite_autoindex_auth_/);assert.doesNotMatch(plan,/SCAN auth_/);
 }
 assert.equal(db.prepare(EXPIRED_LOGIN_SQL).run(500).changes,0);
 assert.equal(db.prepare(EXPIRED_SESSION_SQL).run(500).changes,50);
 assert.equal(db.prepare(EXPIRED_SESSION_SQL).run(500).changes,5);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n,5);
 }finally{db.close();}
});
