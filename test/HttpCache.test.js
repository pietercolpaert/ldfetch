'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const HttpCache = require('../lib/HttpCache.js');
const NodeHttpFetcher = require('../lib/NodeHttpFetcher.js');
const ldfetch = require('../lib/ldfetch.js');

function serve(handler) {
  const server = http.createServer(handler);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`
  })));
}
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });

test('responses without freshness information are revalidated, and a 304 refreshes the stored copy', async () => {
  const seen = [];
  const { server, baseUrl } = await serve((req, res) => {
    seen.push(req.headers['if-none-match']);
    if (req.headers['if-none-match'] === '"v1"') {
      res.writeHead(304, { etag: '"v1"', 'cache-control': 'max-age=0' });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/turtle', etag: '"v1"', 'cache-control': 'max-age=0' });
    res.end('<a> <b> <c> .');
  });
  try {
    const fetcher = new NodeHttpFetcher('text/turtle');
    const first = await fetcher.get(baseUrl + '/r');
    const second = await fetcher.get(baseUrl + '/r');
    assert.deepEqual(seen, [undefined, '"v1"']);
    assert.equal(second.body, first.body);
    assert.equal(second.statusCode, 200);
  } finally {
    await close(server);
  }
});

test('Cache-Control: no-store responses are never stored, not even with a minTTL', async () => {
  let requests = 0;
  const { server, baseUrl } = await serve((req, res) => {
    requests++;
    res.writeHead(200, { 'content-type': 'text/turtle', 'cache-control': 'no-store' });
    res.end('<a> <b> <c> .');
  });
  try {
    const fetcher = new NodeHttpFetcher('text/turtle');
    fetcher.setCache({ minTTL: 60 });
    await fetcher.get(baseUrl + '/r');
    await fetcher.get(baseUrl + '/r');
    assert.equal(requests, 2);
  } finally {
    await close(server);
  }
});

test('minTTL serves stale responses without asking the server, but only for that long', async () => {
  let requests = 0;
  const { server, baseUrl } = await serve((req, res) => {
    requests++;
    res.writeHead(200, { 'content-type': 'text/turtle', 'cache-control': 'max-age=0' });
    res.end('<a> <b> <c> .');
  });
  try {
    const strict = new NodeHttpFetcher('text/turtle');
    await strict.get(baseUrl + '/r');
    await strict.get(baseUrl + '/r');
    assert.equal(requests, 2, 'without minTTL, max-age=0 is honoured');

    requests = 0;
    const lenient = new NodeHttpFetcher('text/turtle');
    lenient.setCache({ minTTL: 60 });
    await lenient.get(baseUrl + '/r');
    await lenient.get(baseUrl + '/r');
    assert.equal(requests, 1, 'within minTTL the stored copy is used');

    // Let the minTTL (here: 0.05s) expire
    const shortLived = new NodeHttpFetcher('text/turtle');
    shortLived.setCache({ minTTL: 0.05 });
    requests = 0;
    await shortLived.get(baseUrl + '/r');
    await new Promise(resolve => setTimeout(resolve, 80));
    await shortLived.get(baseUrl + '/r');
    assert.equal(requests, 2);
  } finally {
    await close(server);
  }
});

test('cache can be disabled and a custom store can be plugged in', async () => {
  let requests = 0;
  const { server, baseUrl } = await serve((req, res) => {
    requests++;
    res.writeHead(200, { 'content-type': 'text/turtle', 'cache-control': 'max-age=60' });
    res.end('<a> <b> <c> .');
  });
  try {
    const uncached = new NodeHttpFetcher('text/turtle');
    uncached.setCache(false);
    await uncached.get(baseUrl + '/r');
    await uncached.get(baseUrl + '/r');
    assert.equal(requests, 2);

    requests = 0;
    const store = new Map();
    const cached = new NodeHttpFetcher('text/turtle');
    cached.setCache({ store });
    await cached.get(baseUrl + '/r');
    await cached.get(baseUrl + '/r');
    assert.equal(requests, 1);
    assert.equal(store.size, 1);

    // another fetcher sharing the same store profits from it
    const other = new NodeHttpFetcher('text/turtle');
    other.setCache(new HttpCache({ store }));
    await other.get(baseUrl + '/r');
    assert.equal(requests, 1);
  } finally {
    await close(server);
  }
});

test('Vary is respected: a different Accept header does not get the stored variant', async () => {
  let requests = 0;
  const { server, baseUrl } = await serve((req, res) => {
    requests++;
    res.writeHead(200, { 'content-type': 'text/turtle', 'cache-control': 'max-age=60', vary: 'Accept' });
    res.end('<a> <b> <c> .');
  });
  try {
    const fetcher = new NodeHttpFetcher('text/turtle');
    await fetcher.get(baseUrl + '/r');
    await fetcher.request(baseUrl + '/r', 'GET', { accept: 'application/json' });
    assert.equal(requests, 2);
  } finally {
    await close(server);
  }
});

async function contextFixture(contextHeaders) {
  const hits = { context: 0, contextAuth: [] };
  const { server, baseUrl } = await serve((req, res) => {
    if (req.url === '/context.jsonld') {
      hits.context++;
      hits.contextAuth.push(req.headers.authorization);
      res.writeHead(200, Object.assign({ 'content-type': 'application/ld+json' }, contextHeaders));
      return res.end(JSON.stringify({ '@context': { name: 'http://xmlns.com/foaf/0.1/name' } }));
    }
    res.writeHead(200, { 'content-type': 'application/ld+json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ '@context': baseUrl + '/context.jsonld', '@id': baseUrl + '/doc', name: 'Alice' }));
  });
  return { server, baseUrl, hits };
}

test('remote JSON-LD contexts are cached following cache semantics', async () => {
  const { server, baseUrl, hits } = await contextFixture({ 'cache-control': 'max-age=3600' });
  try {
    const fetch = new ldfetch({ headers: { Authorization: 'secret' } });
    const first = await fetch.get(baseUrl + '/doc');
    const second = await fetch.get(baseUrl + '/doc');
    assert.equal(first.triples.length, 1);
    assert.equal(first.triples[0].predicate.value, 'http://xmlns.com/foaf/0.1/name');
    assert.equal(second.triples.length, 1);
    assert.equal(hits.context, 1);
    assert.deepEqual(hits.contextAuth, [undefined], 'custom headers are not sent to the context host');
  } finally {
    await close(server);
  }
});

test('contextCache.minTTL keeps a context that claims to be stale around for that long', async () => {
  const { server, baseUrl, hits } = await contextFixture({ 'cache-control': 'max-age=0' });
  try {
    const strict = new ldfetch({});
    await strict.get(baseUrl + '/doc');
    await strict.get(baseUrl + '/doc');
    assert.equal(hits.context, 2);

    hits.context = 0;
    const lenient = new ldfetch({ contextCache: { minTTL: 60 } });
    await lenient.get(baseUrl + '/doc');
    await lenient.get(baseUrl + '/doc');
    assert.equal(hits.context, 1);

    hits.context = 0;
    const none = new ldfetch({ contextCache: false });
    await none.get(baseUrl + '/doc');
    await none.get(baseUrl + '/doc');
    assert.equal(hits.context, 2);
  } finally {
    await close(server);
  }
});

test('maxTTL caps how long a response is served without revalidating', async () => {
  let requests = 0;
  const { server, baseUrl } = await serve((req, res) => {
    requests++;
    res.writeHead(200, { 'content-type': 'text/turtle', 'cache-control': 'max-age=3600' });
    res.end('<a> <b> <c> .');
  });
  try {
    const fetcher = new NodeHttpFetcher('text/turtle');
    fetcher.setCache({ maxTTL: 0.05 });
    await fetcher.get(baseUrl + '/r');
    await fetcher.get(baseUrl + '/r');
    assert.equal(requests, 1);
    await new Promise(resolve => setTimeout(resolve, 80));
    await fetcher.get(baseUrl + '/r');
    assert.equal(requests, 2);
    assert.throws(() => new HttpCache({ minTTL: 10, maxTTL: 5 }), /minTTL/);
  } finally {
    await close(server);
  }
});

test('overrideNoStore is an explicit opt-in to keep no-store responses for minTTL', async () => {
  let requests = 0;
  const { server, baseUrl } = await serve((req, res) => {
    requests++;
    res.writeHead(200, { 'content-type': 'text/turtle', 'cache-control': 'no-store' });
    res.end('<a> <b> <c> .');
  });
  try {
    const fetcher = new NodeHttpFetcher('text/turtle');
    fetcher.setCache({ minTTL: 60, overrideNoStore: true });
    await fetcher.get(baseUrl + '/r');
    await fetcher.get(baseUrl + '/r');
    assert.equal(requests, 1);
  } finally {
    await close(server);
  }
});

test('ldes-client style: documents uncached, contexts shared by many concurrent documents with one request', async () => {
  const { server, baseUrl, hits } = await contextFixture({});
  try {
    const fetch = new ldfetch({ cache: false, contextCache: { minTTL: 600 } });
    await Promise.all([1, 2, 3, 4, 5].map(i => fetch.get(baseUrl + '/doc?' + i)));
    await fetch.get(baseUrl + '/doc?6');
    assert.equal(hits.context, 1);
  } finally {
    await close(server);
  }
});

test('a custom documentLoader replaces the context loading', async () => {
  const { server, baseUrl, hits } = await contextFixture({});
  try {
    const loaded = [];
    const fetch = new ldfetch({ documentLoader: { load: async url => { loaded.push(url); return { '@context': { name: 'http://example.org/name' } }; } } });
    const response = await fetch.get(baseUrl + '/doc');
    assert.equal(hits.context, 0);
    assert.equal(loaded.length, 1);
    assert.equal(response.triples[0].predicate.value, 'http://example.org/name');
  } finally {
    await close(server);
  }
});
