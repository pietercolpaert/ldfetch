'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const HttpCache = require('../lib/HttpCache.js');
const { cachedDocumentLoader } = require('../lib/ContextLoader.js');

const CONTEXT = { '@context': { name: 'http://xmlns.com/foaf/0.1/name' } };
const url = 'https://example.org/context.jsonld';

// A fetch stub over a table of handlers, counting what reaches the "network"
function stubFetch(handler) {
  const calls = [];
  const fetch = async (requestUrl, init) => {
    calls.push({ url: requestUrl, headers: init.headers });
    return handler(requestUrl, init.headers, calls.length);
  };
  fetch.calls = calls;
  return fetch;
}
const jsonLd = (headers) => new Response(JSON.stringify(CONTEXT), { status: 200, headers: Object.assign({ 'content-type': 'application/ld+json' }, headers) });

// Serializes everything on the way in and out, like a disk or Redis store would
function serializingStore() {
  const map = new Map();
  return {
    map,
    get: key => map.has(key) ? JSON.parse(map.get(key)) : undefined,
    set: (key, value) => { map.set(key, JSON.stringify(value)); },
    delete: key => { map.delete(key); }
  };
}

test('parses of documents sharing one context make one request and get the same parsed object', async () => {
  const fetch = stubFetch(() => jsonLd({ 'cache-control': 'max-age=3600' }));
  const loader = cachedDocumentLoader({ fetch, cache: new HttpCache() });
  const first = await loader.load(url);
  const second = await loader.load(url);
  assert.deepEqual(first, CONTEXT);
  assert.equal(second, first);
  assert.equal(fetch.calls.length, 1);
});

test('concurrent loads of one URL share one request', async () => {
  const fetch = stubFetch(async () => { await new Promise(r => setTimeout(r, 20)); return jsonLd({ 'cache-control': 'max-age=3600' }); });
  const loader = cachedDocumentLoader({ fetch, cache: new HttpCache() });
  const results = await Promise.all([1, 2, 3, 4].map(() => loader.load(url)));
  assert.equal(fetch.calls.length, 1);
  assert.ok(results.every(r => r === results[0]));
});

test('without a cache, requests are still shared while in flight but not afterwards', async () => {
  const fetch = stubFetch(async () => { await new Promise(r => setTimeout(r, 10)); return jsonLd(); });
  const loader = cachedDocumentLoader({ fetch });
  await Promise.all([loader.load(url), loader.load(url)]);
  assert.equal(fetch.calls.length, 1);
  await loader.load(url);
  assert.equal(fetch.calls.length, 2);
});

test('a stale entry with an ETag is revalidated, and a 304 refreshes it without re-downloading', async () => {
  const fetch = stubFetch((u, headers) => headers['if-none-match'] === '"v1"'
    ? new Response(null, { status: 304, headers: { etag: '"v1"', 'cache-control': 'max-age=0' } })
    : jsonLd({ etag: '"v1"', 'cache-control': 'max-age=0' }));
  const cache = new HttpCache();
  const loader = cachedDocumentLoader({ fetch, cache });
  const first = await loader.load(url);
  const second = await loader.load(url);
  const third = await loader.load(url);
  assert.deepEqual(fetch.calls.map(c => c.headers['if-none-match']), [undefined, '"v1"', '"v1"']);
  assert.equal(second, first, 'the parsed context survives a 304');
  assert.equal(third, first);
  assert.equal(cache.getStats().revalidations, 2);
});

test('a 304 hidden behind a 200 (reported through getStatus) keeps the original content-type', async () => {
  const fetch = stubFetch((u, headers) => headers['if-none-match']
    ? new Response('', { status: 200, headers: { 'content-type': 'text/plain', 'x-real-status': '304', etag: '"v1"' } })
    : jsonLd({ etag: '"v1"', 'cache-control': 'max-age=0' }));
  const getStatus = response => Number(response.headers.get('x-real-status') || response.status);
  const loader = cachedDocumentLoader({ fetch, cache: new HttpCache({ store: serializingStore() }), getStatus });
  const first = await loader.load(url);
  const second = await loader.load(url);
  assert.deepEqual(second, first);
  assert.equal(fetch.calls.length, 2);
});

test('TTL options and no-store behave as for HttpCache, also with a serializing store', async () => {
  let headers = { 'cache-control': 'max-age=0' };
  const fetch = stubFetch(() => jsonLd(headers));

  const strict = cachedDocumentLoader({ fetch, cache: new HttpCache({ store: serializingStore() }) });
  await strict.load(url);
  await strict.load(url);
  assert.equal(fetch.calls.length, 2, 'max-age=0 is honoured by default');

  fetch.calls.length = 0;
  const lenient = cachedDocumentLoader({ fetch, cache: new HttpCache({ store: serializingStore(), minTTL: 60 }) });
  assert.deepEqual(await lenient.load(url), await lenient.load(url));
  assert.equal(fetch.calls.length, 1, 'minTTL keeps it');

  fetch.calls.length = 0;
  headers = { 'cache-control': 'no-store' };
  const noStore = cachedDocumentLoader({ fetch, cache: new HttpCache({ store: serializingStore(), minTTL: 60 }) });
  await noStore.load(url);
  await noStore.load(url);
  assert.equal(fetch.calls.length, 2, 'no-store is never stored');
});

test('rel="alternate" contexts are resolved and cached', async () => {
  const fetch = stubFetch((u) => u === 'https://example.org/context'
    ? new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html', 'cache-control': 'max-age=3600', link: '</context.jsonld>; rel="alternate"; type="application/ld+json"' } })
    : jsonLd({ 'cache-control': 'max-age=3600' }));
  const loader = cachedDocumentLoader({ fetch, cache: new HttpCache() });
  const first = await loader.load('https://example.org/context');
  const second = await loader.load('https://example.org/context');
  assert.deepEqual(first, CONTEXT);
  assert.equal(second, first);
  assert.deepEqual(fetch.calls.map(c => c.url), ['https://example.org/context', 'https://example.org/context.jsonld']);
});

test('404, 410 and unparsable contexts are not cached, so the next load retries', async () => {
  for (const make of [
    () => new Response('gone', { status: 410, headers: { 'cache-control': 'max-age=3600' } }),
    () => new Response('nope', { status: 404, headers: { 'cache-control': 'max-age=3600' } }),
    () => new Response('{ broken', { status: 200, headers: { 'content-type': 'application/ld+json', 'cache-control': 'max-age=3600' } })
  ]) {
    let broken = true;
    const fetch = stubFetch(() => broken ? make() : jsonLd({ 'cache-control': 'max-age=3600' }));
    const loader = cachedDocumentLoader({ fetch, cache: new HttpCache() });
    await assert.rejects(loader.load(url));
    await assert.rejects(loader.load(url));
    assert.equal(fetch.calls.length, 2);
    broken = false;
    assert.deepEqual(await loader.load(url), CONTEXT);
  }
});

test('only the context Accept header is sent', async () => {
  const fetch = stubFetch(() => jsonLd());
  await cachedDocumentLoader({ fetch, cache: new HttpCache() }).load(url);
  assert.deepEqual(Object.keys(fetch.calls[0].headers), ['accept']);
});
