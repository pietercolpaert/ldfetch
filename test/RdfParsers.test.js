'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const zlib = require('node:zlib');

const RdfParsers = require('../lib/RdfParsers.js');

function collect (options) {
  return new Promise((resolve, reject) => {
    const triples = [];
    const prefixes = {};
    const messages = [];
    RdfParsers.parse(options)
      .on('prefix', (prefix, iri) => { prefixes[prefix] = iri; })
      .on('data', (quad) => triples.push(quad))
      .on('message', (quadsInMessage) => messages.push(quadsInMessage))
      .on('error', reject)
      .on('end', () => resolve({ triples, prefixes, messages }));
  });
}

test('RdfParsers parses Turtle and reports its prefixes', async () => {
  const { triples, prefixes } = await collect({
    bodyText: '@prefix ex: <https://example.org/> .\nex:s ex:p "hello" .',
    contentType: 'text/turtle',
    baseIRI: 'https://example.org/'
  });
  assert.equal(triples.length, 1);
  assert.equal(triples[0].object.value, 'hello');
  assert.equal(prefixes.ex, 'https://example.org/');
});

test('RdfParsers parses TriG with named graphs', async () => {
  const { triples } = await collect({
    bodyText: '<https://example.org/g> { <https://example.org/s> <https://example.org/p> "in a graph" . }',
    contentType: 'application/trig',
    baseIRI: 'https://example.org/'
  });
  assert.equal(triples.length, 1);
  assert.equal(triples[0].graph.value, 'https://example.org/g');
});

test('RdfParsers groups RDF Message Log entries into messages', async () => {
  const { triples, messages } = await collect({
    bodyText: '@version "1.2-messages" .\n<https://example.org/s> <https://example.org/p> "m1" .\nMESSAGE\n<https://example.org/s> <https://example.org/p> "m2" .',
    contentType: 'text/turtle',
    baseIRI: 'https://example.org/'
  });
  assert.equal(triples.length, 2);
  assert.equal(messages.length, 2);
  assert.equal(messages[0][0].object.value, 'm1');
  assert.equal(messages[1][0].object.value, 'm2');
});

test('RdfParsers preserves a deliberately empty message between two delimiters', async () => {
  const { triples, messages } = await collect({
    bodyText: '@version "1.2-messages" .\n' +
      '<https://example.org/s> <https://example.org/p> "m1" .\n' +
      'MESSAGE\n' +
      'MESSAGE\n' +
      '<https://example.org/s> <https://example.org/p> "m3" .',
    contentType: 'text/turtle',
    baseIRI: 'https://example.org/'
  });
  assert.equal(triples.length, 2);
  assert.equal(messages.length, 3);
  assert.equal(messages[0][0].object.value, 'm1');
  assert.equal(messages[1].length, 0);
  assert.equal(messages[2][0].object.value, 'm3');
});

test('RdfParsers never reports messages for ordinary (non-message) Turtle', async () => {
  const { messages } = await collect({
    bodyText: '<https://example.org/s> <https://example.org/p> "plain" .',
    contentType: 'text/turtle',
    baseIRI: 'https://example.org/'
  });
  assert.equal(messages.length, 0);
});

test('RdfParsers tags data events with their messageCounter', async () => {
  const tags = [];
  await new Promise((resolve, reject) => {
    RdfParsers.parse({
      bodyText: '@version "1.2-messages" .\n<https://example.org/s> <https://example.org/p> "m1" .\nMESSAGE\n<https://example.org/s> <https://example.org/p> "m2" .',
      contentType: 'text/turtle',
      baseIRI: 'https://example.org/'
    })
      .on('data', (quad, messageCounter) => tags.push(messageCounter))
      .on('error', reject)
      .on('end', resolve);
  });
  assert.deepEqual(tags, [0, 1]);
});

test('RdfParsers leaves the messageCounter undefined for ordinary (non-message) Turtle', async () => {
  const tags = [];
  await new Promise((resolve, reject) => {
    RdfParsers.parse({
      bodyText: '<https://example.org/s> <https://example.org/p> "plain" .',
      contentType: 'text/turtle',
      baseIRI: 'https://example.org/'
    })
      .on('data', (quad, messageCounter) => tags.push(messageCounter))
      .on('error', reject)
      .on('end', resolve);
  });
  assert.deepEqual(tags, [undefined]);
});

test('RdfParsers.parseStream emits message boundaries progressively, not just at the end (issue #59 follow-up)', async () => {
  const { PassThrough } = require('node:stream');
  const input = new PassThrough();
  const events = [];
  const emitter = RdfParsers.parseStream(input, { contentType: 'text/turtle', baseIRI: 'https://example.org/' });
  const donePromise = new Promise((resolve, reject) => {
    emitter.on('message', (quadsInMessage) => events.push(['message', quadsInMessage.length]));
    emitter.on('error', reject);
    emitter.on('end', () => { events.push(['end']); resolve(); });
  });

  input.write('@version "1.2-messages" .\n<https://example.org/s> <https://example.org/p> "m1" .\nMESSAGE\n');
  input.write('<https://example.org/s> <https://example.org/p> "m2" .\nMESSAGE\n');
  // The first message is only ever confirmed complete once evidence of what
  // follows it arrives (here, message 2's own quad) -- but crucially that
  // happens well before the stream ends (still open below): if 'message'
  // only fired at 'end' (the old toMessages()-at-end grouping), this would
  // still be empty here.
  await new Promise((resolve) => emitter.once('message', () => setImmediate(resolve)));
  assert.deepEqual(events, [['message', 1]]);

  input.end('<https://example.org/s> <https://example.org/p> "m3" .');
  await donePromise;
  assert.deepEqual(events, [['message', 1], ['message', 1], ['message', 1], ['end']]);
});

test('RdfParsers parses JSON-LD', async () => {
  const { triples } = await collect({
    bodyText: JSON.stringify({ '@id': 'https://example.org/s', 'https://example.org/p': 'from json-ld' }),
    contentType: 'application/ld+json',
    baseIRI: 'https://example.org/'
  });
  assert.equal(triples.length, 1);
  assert.equal(triples[0].object.value, 'from json-ld');
});

test('RdfParsers parses RDF/XML', async () => {
  const xml = '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:ex="https://example.org/">' +
    '<rdf:Description rdf:about="https://example.org/s"><ex:p>from rdf/xml</ex:p></rdf:Description></rdf:RDF>';
  const { triples } = await collect({
    bodyText: xml,
    contentType: 'application/rdf+xml',
    baseIRI: 'https://example.org/'
  });
  assert.equal(triples.length, 1);
  assert.equal(triples[0].object.value, 'from rdf/xml');
});

test('RdfParsers extracts both RDFa and Microdata from HTML', async () => {
  const html = '<html><body>' +
    '<div vocab="https://example.org/" resource="https://example.org/rdfa-subject"><span property="p">from rdfa</span></div>' +
    '<div itemscope itemtype="https://schema.org/Person"><span itemprop="name">from microdata</span></div>' +
    '</body></html>';
  const { triples } = await collect({
    bodyText: html,
    contentType: 'text/html',
    baseIRI: 'https://example.org/'
  });
  const objectValues = triples.map((triple) => triple.object.value);
  assert.ok(objectValues.includes('from rdfa'));
  assert.ok(objectValues.includes('from microdata'));
});

test('RdfParsers merges embedded JSON-LD <script> blocks with RDFa/Microdata from the same HTML page', async () => {
  const html = '<html><body>' +
    '<div vocab="https://example.org/" resource="https://example.org/rdfa-subject"><span property="p">from rdfa</span></div>' +
    '<script type="application/ld+json" id="profile">' +
    '{"@context": {"schema": "https://schema.org/"}, "@id": "https://example.org/jsonld-subject", "schema:name": "from json-ld"}' +
    '</script>' +
    '</body></html>';
  const { triples } = await collect({
    bodyText: html,
    contentType: 'text/html',
    baseIRI: 'https://example.org/'
  });
  const objectValues = triples.map((triple) => triple.object.value);
  assert.ok(objectValues.includes('from rdfa'), 'RDFa is still extracted');
  assert.ok(objectValues.includes('from json-ld'), 'the embedded JSON-LD script block is also extracted');
});

test('RdfParsers skips a malformed embedded JSON-LD <script> block without losing RDFa/other JSON-LD blocks', async () => {
  const html = '<html><body>' +
    '<div vocab="https://example.org/" resource="https://example.org/rdfa-subject"><span property="p">from rdfa</span></div>' +
    '<script type="application/ld+json">{ this is not valid json }</script>' +
    '<script type="application/ld+json">{"@id": "https://example.org/s2", "https://example.org/p": "still works"}</script>' +
    '</body></html>';
  const { triples } = await collect({
    bodyText: html,
    contentType: 'text/html',
    baseIRI: 'https://example.org/'
  });
  const objectValues = triples.map((triple) => triple.object.value);
  assert.ok(objectValues.includes('from rdfa'));
  assert.ok(objectValues.includes('still works'));
});

test('RdfParsers resolves a remote @context referenced by an embedded JSON-LD <script> block', async () => {
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/ld+json' });
    res.end(JSON.stringify({ '@context': { schema: 'https://schema.org/' } }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const contextUrl = `http://127.0.0.1:${server.address().port}/context.jsonld`;
    const html = '<html><body>' +
      `<script type="application/ld+json">{"@context": "${contextUrl}", "@id": "https://example.org/s", "schema:name": "remote context resolved"}</script>` +
      '</body></html>';
    const { triples } = await collect({
      bodyText: html,
      contentType: 'text/html',
      baseIRI: 'https://example.org/'
    });
    assert.ok(triples.some((triple) => triple.object.value === 'remote context resolved'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('RdfParsers routes remote JSON-LD contexts through the configured proxy', async () => {
  const http = require('node:http');
  let requestedPath;
  const server = http.createServer((req, res) => {
    requestedPath = req.url;
    res.writeHead(200, { 'content-type': 'application/ld+json' });
    res.end(JSON.stringify({ '@context': { schema: 'https://schema.org/' } }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const proxy = `http://127.0.0.1:${server.address().port}/proxy/`;
    const contextUrl = 'http://contexts.example/context.jsonld';
    const { triples } = await collect({
      bodyText: JSON.stringify({ '@context': contextUrl, '@id': 'https://example.org/s', 'schema:name': 'proxied context resolved' }),
      contentType: 'application/ld+json',
      baseIRI: 'https://example.org/document.jsonld',
      proxy
    });
    assert.equal(requestedPath, '/proxy/http://contexts.example/context.jsonld');
    assert.ok(triples.some((triple) => triple.object.value === 'proxied context resolved'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('RdfParsers parses SHACL Compact syntax and reports its default prefixes', async () => {
  const shaclc = 'PREFIX ex: <https://example.org/test#>\n' +
    'shape ex:TestShape -> ex:TestClass {\n  targetNode=ex:TestNode .\n}';
  const { triples, prefixes } = await collect({
    bodyText: shaclc,
    contentType: 'text/shaclc',
    baseIRI: 'https://example.org/'
  });
  assert.ok(triples.length > 0);
  assert.equal(prefixes.sh, 'http://www.w3.org/ns/shacl#');
  assert.equal(prefixes.ex, 'https://example.org/test#');
});

test('RdfParsers parses Jelly-RDF and reports it as message-framed', async () => {
  const { DataFactory, Writer } = require('rdfjs-jelly');
  const { namedNode, literal, quad } = DataFactory;
  const bytes = await new Promise((resolve, reject) => {
    const writer = new Writer({ namespaces: { ex: 'https://example.org/' } });
    writer.addQuad(quad(namedNode('https://example.org/s'), namedNode('https://example.org/p'), literal('from jelly')));
    writer.end((error, output) => error ? reject(error) : resolve(output));
  });

  const { triples, prefixes, messages } = await collect({
    bodyBuffer: bytes,
    contentType: 'application/x-jelly-rdf',
    baseIRI: 'https://example.org/'
  });
  assert.equal(triples.length, 1);
  assert.equal(triples[0].object.value, 'from jelly');
  assert.equal(prefixes.ex, 'https://example.org/');
  assert.equal(messages.length, 1);
});

test('RdfParsers rejects unsupported content types', async () => {
  await assert.rejects(
    collect({ bodyText: 'whatever', contentType: 'application/x-not-a-real-format' }),
    /Unsupported content type/
  );
});

test('RdfParsers falls back to a suffix-based guess for text/plain', async () => {
  const { triples } = await collect({
    bodyText: '@prefix ex: <https://example.org/> .\nex:s ex:p "guessed from .ttl" .',
    contentType: 'text/plain',
    baseIRI: 'https://example.org/data.ttl'
  });
  assert.equal(triples.length, 1);
  assert.equal(triples[0].object.value, 'guessed from .ttl');
});

test('RdfParsers falls back to a suffix-based guess for application/octet-stream', async () => {
  const { triples } = await collect({
    bodyText: JSON.stringify({ '@id': 'https://example.org/s', 'https://example.org/p': 'guessed from .jsonld' }),
    contentType: 'application/octet-stream',
    baseIRI: 'https://example.org/data.jsonld'
  });
  assert.equal(triples.length, 1);
  assert.equal(triples[0].object.value, 'guessed from .jsonld');
});

test('RdfParsers ignores query strings and fragments when guessing from the URL', async () => {
  const { triples } = await collect({
    bodyText: '<https://example.org/s> <https://example.org/p> "still guessed" .',
    contentType: 'text/plain',
    baseIRI: 'https://example.org/data.ttl?version=2#fragment'
  });
  assert.equal(triples.length, 1);
});

test('RdfParsers keeps text/plain as-is when the extension is unrecognized', async () => {
  await assert.rejects(
    collect({ bodyText: 'whatever', contentType: 'text/plain', baseIRI: 'https://example.org/data.unknownext' }),
    /Unsupported content type: text\/plain/
  );
});

test('RdfParsers does not second-guess a properly declared content type', async () => {
  const { triples } = await collect({
    bodyText: '@prefix ex: <https://example.org/> .\nex:s ex:p "declared, not guessed" .',
    contentType: 'text/turtle',
    baseIRI: 'https://example.org/data.jsonld'
  });
  assert.equal(triples.length, 1);
  assert.equal(triples[0].object.value, 'declared, not guessed');
});

test('RdfParsers transparently decompresses a gzip-compressed Turtle file', async () => {
  const turtle = '@prefix ex: <https://example.org/> .\nex:s ex:p "from gzip" .';
  const { triples, prefixes } = await collect({
    bodyBuffer: zlib.gzipSync(Buffer.from(turtle)),
    contentType: 'application/octet-stream',
    baseIRI: 'https://example.org/data.ttl.gz'
  });
  assert.equal(triples.length, 1);
  assert.equal(triples[0].object.value, 'from gzip');
  assert.equal(prefixes.ex, 'https://example.org/');
});

test('RdfParsers transparently decompresses a zstd-compressed Turtle file', async () => {
  // Compress with the same WASM library RdfParsers.js uses to decompress
  // (@hpcc-js/wasm-zstd), not zlib.zstdCompressSync -- that's Node's native
  // zstd support, only available on much newer Node than this project
  // targets (engines: >=18), and the whole point of the WASM library is to
  // not need it.
  const { Zstd } = require('@hpcc-js/wasm-zstd');
  const zstd = await Zstd.load();
  const turtle = '@prefix ex: <https://example.org/> .\nex:s ex:p "from zstd" .';
  const { triples } = await collect({
    bodyBuffer: Buffer.from(zstd.compress(new TextEncoder().encode(turtle))),
    contentType: 'application/octet-stream',
    baseIRI: 'https://example.org/data.ttl.zst'
  });
  assert.equal(triples.length, 1);
  assert.equal(triples[0].object.value, 'from zstd');
});

test('RdfParsers detects compression from magic bytes even with a misleading content type', async () => {
  const turtle = '<https://example.org/s> <https://example.org/p> "still detected" .';
  const { triples } = await collect({
    bodyBuffer: zlib.gzipSync(Buffer.from(turtle)),
    contentType: 'text/turtle',
    baseIRI: 'https://example.org/data.ttl.gz'
  });
  assert.equal(triples.length, 1);
});

test('RdfParsers decompresses gzip-compressed Jelly-RDF', async () => {
  const { DataFactory, Writer } = require('rdfjs-jelly');
  const { namedNode, literal, quad } = DataFactory;
  const jellyBytes = await new Promise((resolve, reject) => {
    const writer = new Writer({ namespaces: { ex: 'https://example.org/' } });
    writer.addQuad(quad(namedNode('https://example.org/s'), namedNode('https://example.org/p'), literal('from gzipped jelly')));
    writer.end((error, output) => error ? reject(error) : resolve(output));
  });

  const { triples, prefixes } = await collect({
    bodyBuffer: zlib.gzipSync(jellyBytes),
    contentType: 'application/octet-stream',
    baseIRI: 'https://example.org/data.jelly.gz'
  });
  assert.equal(triples.length, 1);
  assert.equal(triples[0].object.value, 'from gzipped jelly');
  assert.equal(prefixes.ex, 'https://example.org/');
});

test('RdfParsers falls back to the original request URL for extension guessing when a redirect drops it', async () => {
  // Mirrors real-world redirects to opaque storage URLs (GitHub release
  // assets, signed S3/Azure Blob URLs, ...): the final response URL
  // (baseIRI) no longer carries the ".jelly.gz" extension, but the
  // originally requested URL (requestUrl) still does.
  const { DataFactory, Writer } = require('rdfjs-jelly');
  const { namedNode, literal, quad } = DataFactory;
  const jellyBytes = await new Promise((resolve, reject) => {
    const writer = new Writer({ namespaces: { ex: 'https://example.org/' } });
    writer.addQuad(quad(namedNode('https://example.org/s'), namedNode('https://example.org/p'), literal('from redirected jelly')));
    writer.end((error, output) => error ? reject(error) : resolve(output));
  });

  const { triples } = await collect({
    bodyBuffer: zlib.gzipSync(jellyBytes),
    contentType: 'application/octet-stream',
    baseIRI: 'https://storage.example.com/blob/e34d9512-a5f2-4c0a-bc12-04cc8a84b649?sig=abc',
    requestUrl: 'https://example.org/data/jelly_10K.jelly.gz'
  });
  assert.equal(triples.length, 1);
  assert.equal(triples[0].object.value, 'from redirected jelly');
});
