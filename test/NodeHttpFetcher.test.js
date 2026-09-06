'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const NodeHttpFetcher = require('../lib/NodeHttpFetcher.js');

const fixtureUrl = pathToFileURL(path.join(__dirname, 'fixtures', 'example.ttl')).toString();

function createServer(handler) {
  const server = http.createServer(handler);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${server.address().port}`
      });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close(error => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

test('NodeHttpFetcher sends accept and custom headers', async () => {
  let requestHeaders;
  const { server, baseUrl } = await createServer((req, res) => {
    requestHeaders = req.headers;
    res.writeHead(200, { 'content-type': 'application/ld+json; charset=utf-8' });
    res.end('{"@id":"https://example.org/alice"}');
  });

  try {
    const fetcher = new NodeHttpFetcher('text/turtle', { 'X-Custom-Header': 'expected' });
    const response = await fetcher.get(`${baseUrl}/resource`);

    assert.equal(requestHeaders.accept, 'text/turtle');
    assert.equal(requestHeaders['x-custom-header'], 'expected');
    assert.equal(requestHeaders['user-agent'], 'Linked Data Fetch for NodeJS');
    assert.equal(response.type, 'application/ld+json');
    assert.equal(response.body, '{"@id":"https://example.org/alice"}');
    assert.equal(response.statusCode, 200);
  } finally {
    await closeServer(server);
  }
});

test('NodeHttpFetcher caches GET responses and ignores URL fragments in the cache key', async () => {
  let requestCount = 0;
  const events = [];
  const { server, baseUrl } = await createServer((req, res) => {
    requestCount++;
    res.writeHead(200, { 'content-type': 'text/turtle', 'cache-control': 'max-age=60' });
    res.end(`request ${requestCount}`);
  });

  try {
    const fetcher = new NodeHttpFetcher('text/turtle');
    fetcher.on('cache-miss', url => events.push(['miss', url]));
    fetcher.on('cache-hit', url => events.push(['hit', url]));

    const firstResponse = await fetcher.get(`${baseUrl}/resource#first`);
    const secondResponse = await fetcher.get(`${baseUrl}/resource#second`);

    assert.equal(requestCount, 1);
    assert.equal(firstResponse.body, 'request 1');
    assert.equal(secondResponse.body, 'request 1');
    assert.deepEqual(events.map(event => event[0]), ['miss', 'hit']);
  } finally {
    await closeServer(server);
  }
});

test('NodeHttpFetcher rejects server errors', async () => {
  const { server, baseUrl } = await createServer((req, res) => {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('Unavailable');
  });

  try {
    const fetcher = new NodeHttpFetcher('text/plain', false);

    await assert.rejects(
      fetcher.get(`${baseUrl}/unavailable`),
      /Request failed:/
    );
  } finally {
    await closeServer(server);
  }
});

test('NodeHttpFetcher rejects file:// URLs by default', async () => {
  const fetcher = new NodeHttpFetcher('text/turtle');

  await assert.rejects(
    fetcher.get(fixtureUrl),
    /localFiles/
  );
});

test('NodeHttpFetcher reads file:// URLs when localFiles is enabled', async () => {
  const fetcher = new NodeHttpFetcher('text/turtle');
  fetcher.localFiles = true;

  const response = await fetcher.get(fixtureUrl);

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /Alice/);
});

test('NodeHttpFetcher rejects missing local files with localFiles enabled', async () => {
  const fetcher = new NodeHttpFetcher('text/turtle');
  fetcher.localFiles = true;

  await assert.rejects(
    fetcher.get(pathToFileURL(path.join(__dirname, 'fixtures', 'does-not-exist.ttl')).toString()),
    /Request failed:/
  );
});
