'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

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
