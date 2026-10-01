import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/worker/index.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY = 'owner/repository';
const SECRET = 'github-secret';

class D1Statement {
  constructor(database, sql, values = []) { this.database = database; this.sql = sql; this.values = values; }
  bind(...values) { return new D1Statement(this.database, this.sql, values); }
  runSync() { const result = this.database.prepare(this.sql).run(...this.values); return { meta: { changes: Number(result.changes) } }; }
  async run() { return this.runSync(); }
  async first() { return this.database.prepare(this.sql).get(...this.values) ?? null; }
  async all() { return { results: this.database.prepare(this.sql).all(...this.values) }; }
}

class SqliteD1 {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec('PRAGMA foreign_keys = ON;');
    for (const name of readdirSync(join(root, 'migrations')).filter((item) => /^\d+.*\.sql$/.test(item)).sort()) {
      this.sqlite.exec(readFileSync(join(root, 'migrations', name), 'utf8'));
    }
  }
  prepare(sql) { return new D1Statement(this.sqlite, sql); }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try {
      const results = statements.map((statement) => statement.runSync());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
}

function runtime(database) {
  return {
    DB: database,
    ASSETS: { fetch: async () => new Response('<!doctype html>') },
    MEDIA_MODE: 'external',
    ALLOWED_ORIGINS: 'https://eat.shoumc.com',
    PUBLICATION_ENABLED: 'true',
    LEGACY_SUBMISSIONS_ENABLED: 'false',
    TURNSTILE_SECRET_KEY: 'turnstile-secret',
    TURNSTILE_HOSTNAME: 'eat.shoumc.com',
    ACCESS_TEAM_DOMAIN: 'team.example.cloudflareaccess.com',
    ACCESS_AUD: 'access-audience',
    ACCESS_REVIEWER_EMAIL: 'reviewer@example.com',
    GITHUB_APP_ID: '123',
    GITHUB_PRIVATE_KEY: 'private-key',
    GITHUB_INSTALLATION_ID: '123',
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_WEBHOOK_SECRET: SECRET,
    DEPLOY_WEBHOOK_SECRET: 'deploy-secret',
  };
}

function insertJob(database, status = 'pr_open') {
  const now = '2026-10-01T00:00:00.000Z';
  database.sqlite.prepare("INSERT INTO submissions (id, type, original_json, revision_json, receipt_hash, status, version, created_at, updated_at, schema_version, entity_type, entity_id, upload_state) VALUES ('submission-webhook', 'new', '{}', '{}', 'receipt-hash', 'exporting', 2, ?, ?, 2, 'venue', 'venue-webhook', 'pending')").run(now, now);
  database.sqlite.prepare("INSERT INTO publication_jobs (id, submission_id, submission_version, content_hash, status, branch, attempts, created_at, updated_at) VALUES ('job-webhook', 'submission-webhook', 2, ?, ?, 'submission/webhook', 0, ?, ?)").run('b'.repeat(64), status, now, now);
}

function pullRequest({ action = 'opened', merged = false, base = 'dev', head = 'submission/webhook', number = 7, mergeCommit = 'a'.repeat(40) } = {}) {
  return {
    action,
    repository: { full_name: REPOSITORY },
    pull_request: {
      number,
      merged,
      head: { ref: head },
      base: { ref: base },
      merge_commit_sha: mergeCommit,
    },
  };
}

async function sendWebhook(database, delivery, payload) {
  const body = JSON.stringify(payload);
  return worker.fetch(new Request('https://eat.shoumc.com/api/v1/webhooks/github', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': 'pull_request',
      'X-GitHub-Delivery': delivery,
      'X-Hub-Signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
    },
    body,
  }), runtime(database), {});
}

function jobStatus(database) { return database.sqlite.prepare('SELECT status FROM publication_jobs WHERE id = \'job-webhook\'').get().status; }
function submissionStatus(database) { return database.sqlite.prepare('SELECT status FROM submissions WHERE id = \'submission-webhook\'').get().status; }
function publishAuditCount(database) { return database.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE submission_id = 'submission-webhook' AND action = 'publish'").get().count; }

test('submission PR webhook advances once, restores closed, and ignores late delivery order', async () => {
  const database = new SqliteD1();
  insertJob(database, 'pr_open');

  assert.equal((await sendWebhook(database, 'closed-before-open', pullRequest({ action: 'closed' }))).status, 200);
  assert.equal(jobStatus(database), 'closed');
  assert.equal((await sendWebhook(database, 'reopened', pullRequest({ action: 'opened' }))).status, 200);
  assert.equal(jobStatus(database), 'pr_open');

  const mergedPayload = pullRequest({ action: 'closed', merged: true });
  assert.equal((await sendWebhook(database, 'merged', mergedPayload)).status, 200);
  assert.equal(jobStatus(database), 'merged_dev');
  assert.equal(submissionStatus(database), 'merged_dev');
  assert.equal(publishAuditCount(database), 1);

  const duplicate = await sendWebhook(database, 'merged', mergedPayload);
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), { received: true, duplicate: true });
  assert.equal(publishAuditCount(database), 1);

  assert.equal((await sendWebhook(database, 'late-opened', pullRequest({ action: 'opened' }))).status, 200);
  assert.equal((await sendWebhook(database, 'late-closed', pullRequest({ action: 'closed' }))).status, 200);
  assert.equal(jobStatus(database), 'merged_dev');
  assert.equal(submissionStatus(database), 'merged_dev');
  assert.equal(publishAuditCount(database), 1);
});

test('submission PR webhook ignores wrong base or repository and never regresses deployed state', async () => {
  const database = new SqliteD1();
  insertJob(database, 'pr_open');

  assert.equal((await sendWebhook(database, 'wrong-base', pullRequest({ action: 'closed', base: 'main' }))).status, 200);
  assert.equal(jobStatus(database), 'pr_open');

  const wrongRepository = pullRequest({ action: 'closed' });
  wrongRepository.repository.full_name = 'attacker/repository';
  assert.equal((await sendWebhook(database, 'wrong-repository', wrongRepository)).status, 403);
  assert.equal(jobStatus(database), 'pr_open');

  const merged = await sendWebhook(database, 'valid-merge', pullRequest({ action: 'closed', merged: true }));
  assert.equal(merged.status, 200);
  database.sqlite.prepare("UPDATE publication_jobs SET status = 'merged_main' WHERE id = 'job-webhook'").run();
  database.sqlite.prepare("UPDATE submissions SET status = 'merged_main' WHERE id = 'submission-webhook'").run();
  assert.equal((await sendWebhook(database, 'late-synchronize', pullRequest({ action: 'synchronize' }))).status, 200);
  assert.equal(jobStatus(database), 'merged_main');
  assert.equal(submissionStatus(database), 'merged_main');

  database.sqlite.prepare("UPDATE publication_jobs SET status = 'deployed' WHERE id = 'job-webhook'").run();
  database.sqlite.prepare("UPDATE submissions SET status = 'deployed' WHERE id = 'submission-webhook'").run();
  assert.equal((await sendWebhook(database, 'late-deployed-close', pullRequest({ action: 'closed' }))).status, 200);
  assert.equal(jobStatus(database), 'deployed');
  assert.equal(submissionStatus(database), 'deployed');
  assert.equal(publishAuditCount(database), 1);
});
