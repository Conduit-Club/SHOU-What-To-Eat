import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker/index.ts';
import { isDatabaseError } from '../src/worker/errors.ts';
import { loadCatalog } from '../src/utils/load-catalog.ts';

function runtime(error) {
  const fail = async () => { throw error; };
  return {
    CONTENT_MODE: 'live', PUBLICATION_ENABLED: 'true',
    DB: { prepare: () => ({ first: fail, bind() { return this; } }), batch: fail },
    ASSETS: { fetch: async () => new Response('static page') },
  };
}
const request = path => new Request(`https://example.test${path}`);

test('D1 failures return a safe database error on public APIs, catalog and detail pages', async () => {
  const env = runtime(new Error('D1_ERROR: exceeded daily limit; private SQL and bindings'));
  for (const path of ['/catalog-index.json', '/api/v2/public/catalog', '/api/v2/public/version', '/api/v2/public/food/test']) {
    const response = await worker.fetch(request(path), env, {});
    assert.equal(response.status, 503, path);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await response.json(), { error: { code: 'database_error', message: '数据库错误，请稍后重试。' } });
  }
  for (const path of ['/foods/test/', '/restaurants/test/']) {
    const response = await worker.fetch(request(path), env, {});
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(await response.text(), '数据库错误，请稍后重试。');
  }
  assert.equal(await (await worker.fetch(request('/'), env, {})).text(), 'static page');
});

test('non-database failures stay generic and protected routes still require Access', async () => {
  const response = await worker.fetch(request('/catalog-index.json'), runtime(new Error('private internal data')), {});
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: { code: 'internal_error', message: '请求暂时无法处理。' } });
  const protectedResponse = await worker.fetch(request('/api/v2/admin/publications'), runtime(new Error('D1_ERROR: private')), {});
  assert.equal(protectedResponse.status, 401);
  assert.equal((await protectedResponse.json()).error.code, 'unauthorized');
});

test('D1 cause classification is bounded and does not classify unrelated errors', () => {
  assert.equal(isDatabaseError(new Error('wrapper', { cause: new Error('D1_EXEC_ERROR: private') })), true);
  const cycle = new Error('unrelated'); cycle.cause = cycle;
  assert.equal(isDatabaseError(cycle), false);
  assert.equal(isDatabaseError(new Error('network error')), false);
});

test('catalog loader preserves database errors, hides diagnostics and recovers on retry', async t => {
  const responses = [
    Response.json({ error: { code: 'database_error', message: 'private diagnostics' } }, { status: 503 }),
    new Response('private upstream failure', { status: 502 }),
    Response.json({ foods: [], venues: [], revision: 1 }),
  ];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/catalog-index.json');
    assert.equal(options.cache, 'no-store');
    return responses.shift();
  });
  await assert.rejects(loadCatalog(), /^Error: 数据库错误，请稍后重试。$/);
  await assert.rejects(loadCatalog(), /^Error: 目录暂时无法加载，请稍后重试。$/);
  assert.deepEqual(await loadCatalog(), { foods: [], venues: [], revision: 1 });
});
