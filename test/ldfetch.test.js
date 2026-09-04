'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const LDFetch = require('../lib/ldfetch.js');

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

test('ldfetch fetches RDF, parses triples and emits lifecycle events', async () => {
  let requestHeaders;
  const events = [];
  const { server, baseUrl } = await createServer((req, res) => {
    requestHeaders = req.headers;
    res.writeHead(200, { 'content-type': 'text/turtle; charset=utf-8' });
    res.end('<#me> <https://schema.org/name> "Alice" .');
  });

  try {
    const fetcher = new LDFetch({ headers: { 'X-Test-Header': 'expected' } });
    fetcher.on('request', url => events.push(['request', url]));
    fetcher.on('downloaded', event => events.push(['downloaded', event.totalBytes]));
    fetcher.on('response', url => events.push(['response', url]));
    fetcher.on('parsed', url => events.push(['parsed', url]));

    const response = await fetcher.get(`${baseUrl}/profile`);

    assert.equal(requestHeaders['x-test-header'], 'expected');
    assert.match(requestHeaders.accept, /application\/trig/);
    assert.equal(response.statusCode, 200);
    assert.equal(response.url, `${baseUrl}/profile`);
    assert.equal(response.triples.length, 1);

    const triple = response.triples[0];
    assert.equal(triple.subject.value, `${baseUrl}/profile#me`);
    assert.equal(triple.predicate.value, 'https://schema.org/name');
    assert.equal(triple.object.value, 'Alice');
    assert.deepEqual(events.map(event => event[0]), ['request', 'downloaded', 'response', 'parsed']);
  } finally {
    await closeServer(server);
  }
});

test('ldfetch emits a quad event per parsed triple and picks up document-declared prefixes', async () => {
  const { server, baseUrl } = await createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/turtle; charset=utf-8' });
    res.end('@prefix foaf: <http://xmlns.com/foaf/0.1/> .\n<#me> foaf:name "Alice" ; foaf:age "30" .');
  });

  try {
    const fetcher = new LDFetch();
    fetcher.addPrefix('hydra', 'http://www.w3.org/ns/hydra/core#');
    const quads = [];
    fetcher.on('quad', quad => quads.push(quad));

    const response = await fetcher.get(`${baseUrl}/profile`);

    assert.equal(quads.length, 2);
    assert.deepEqual(quads, response.triples);
    assert.equal(response.prefixes.foaf, 'http://xmlns.com/foaf/0.1/');
    assert.equal(response.prefixes.hydra, 'http://www.w3.org/ns/hydra/core#');
  } finally {
    await closeServer(server);
  }
});

test('ldfetch groups an RDF Message Log fetch into response.messages and emits message events', async () => {
  const { server, baseUrl } = await createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/turtle; charset=utf-8' });
    res.end('@version "1.2-messages" .\n<#s> <https://schema.org/name> "first" .\nMESSAGE\n<#s> <https://schema.org/name> "second" .');
  });

  try {
    const fetcher = new LDFetch();
    const messageEvents = [];
    fetcher.on('message', quadsInMessage => messageEvents.push(quadsInMessage));

    const response = await fetcher.get(`${baseUrl}/log`);

    assert.equal(response.triples.length, 2);
    assert.equal(response.messages.length, 2);
    assert.equal(response.messages[0][0].object.value, 'first');
    assert.equal(response.messages[1][0].object.value, 'second');
    assert.equal(messageEvents.length, 2);
  } finally {
    await closeServer(server);
  }
});

test('ldfetch reports the final URL and emits redirect events after HTTP redirects', async () => {
  const { server, baseUrl } = await createServer((req, res) => {
    if (req.url === '/from') {
      res.writeHead(302, { location: '/to' });
      res.end();
      return;
    }

    res.writeHead(200, { 'content-type': 'text/turtle' });
    res.end('<#resource> <https://schema.org/name> "Redirect target" .');
  });

  try {
    const fetcher = new LDFetch();
    let redirect;
    fetcher.on('redirect', event => {
      redirect = event;
    });

    const response = await fetcher.get(`${baseUrl}/from`);

    assert.equal(response.url, `${baseUrl}/to`);
    assert.deepEqual(redirect, {
      from: `${baseUrl}/from`,
      to: `${baseUrl}/to`
    });
    assert.equal(response.triples[0].subject.value, `${baseUrl}/to#resource`);
  } finally {
    await closeServer(server);
  }
});

test('ldfetch fetches binary Jelly-RDF over real HTTP', async () => {
  const { DataFactory, Writer } = require('rdfjs-jelly');
  const { namedNode, literal, quad } = DataFactory;
  const jellyBytes = await new Promise((resolve, reject) => {
    const writer = new Writer({ namespaces: { ex: 'https://example.org/' } });
    writer.addQuad(quad(namedNode('https://example.org/s'), namedNode('https://example.org/p'), literal('binary over the wire')));
    writer.end((error, output) => error ? reject(error) : resolve(output));
  });

  const { server, baseUrl } = await createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-jelly-rdf' });
    res.end(jellyBytes);
  });

  try {
    const fetcher = new LDFetch();
    const response = await fetcher.get(`${baseUrl}/data.jelly`);

    assert.equal(response.triples.length, 1);
    assert.equal(response.triples[0].object.value, 'binary over the wire');
    assert.equal(response.prefixes.ex, 'https://example.org/');
  } finally {
    await closeServer(server);
  }
});

test('ldfetch.frame applies a JSON-LD frame to parsed triples', async () => {
  const { server, baseUrl } = await createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/turtle; charset=utf-8' });
    res.end('<#me> a <https://schema.org/Person>; <https://schema.org/name> "Alice"@en .');
  });

  try {
    const fetcher = new LDFetch();
    const framed = await fetcher.frame(`${baseUrl}/profile`, {
      '@context': {
        schema: 'https://schema.org/',
        name: 'schema:name'
      },
      '@type': 'schema:Person'
    });

    assert.equal(framed['@id'], `${baseUrl}/profile#me`);
    assert.equal(framed.name['@value'], 'Alice');
    assert.equal(framed.name['@language'], 'en');
  } finally {
    await closeServer(server);
  }
});