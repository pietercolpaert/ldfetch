'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Writer } = require('rdf-writer-ts');
const df = require('@rdfjs/data-model').default;

const PrefixedWriter = require('../lib/PrefixedWriter.js');

const EX = 'https://example.org/';
const TABLE = {
  'https://schema.org/': 'schema',
  'http://www.w3.org/2001/XMLSchema#': 'xsd',
  'http://purl.obolibrary.org/obo/GO_': 'go'
};

function serialize (quads, prefixes, options) {
  const writer = new PrefixedWriter(new Writer(options), { table: TABLE, enabled: !(options && options.format) });
  writer.addPrefixes(prefixes || {});
  writer.addQuads(quads);
  let output;
  writer.end((error, result) => { output = result; });
  return output;
}

const q = (s, p, o) => df.quad(df.namedNode(s), df.namedNode(p), o);

test('only the prefixes that are used are declared, in one block', () => {
  const output = serialize([
    q(EX + 'a', 'https://schema.org/name', df.literal('A')),
    q(EX + 'a', 'https://schema.org/age', df.literal('4', df.namedNode('http://www.w3.org/2001/XMLSchema#integer')))
  ], { ex: EX, unused: 'https://unused.example/' });
  assert.equal(output, '@prefix ex: <https://example.org/>.\n@prefix schema: <https://schema.org/>.\n\n' +
    'ex:a schema:name "A";\n    schema:age 4.\n');
});

test('prefixes declared by the source take precedence over the table', () => {
  const output = serialize([q(EX + 'a', 'https://schema.org/name', df.literal('A'))], { s: 'https://schema.org/' });
  assert.match(output, /^@prefix s: <https:\/\/schema\.org\/>\.\n\n/);
  assert.match(output, /s:name/);
});

test('the most specific table namespace is used, and datatypes count as used', () => {
  const output = serialize([
    q('http://purl.obolibrary.org/obo/GO_0001', EX + 'p', df.literal('2026-01-01', df.namedNode('http://www.w3.org/2001/XMLSchema#date')))
  ]);
  assert.match(output, /@prefix go: <http:\/\/purl\.obolibrary\.org\/obo\/GO_>\./);
  assert.match(output, /@prefix xsd: /);
  assert.match(output, /go:0001 <https:\/\/example\.org\/p> "2026-01-01"\^\^xsd:date\./);
});

test('a label bound to another namespace gets a numeric suffix', () => {
  const output = serialize([
    q('http://schema.org/a', 'https://schema.org/name', df.literal('A'))
  ], { schema: 'http://schema.org/' });
  assert.match(output, /@prefix schema: <http:\/\/schema\.org\/>\.\n@prefix schema2: <https:\/\/schema\.org\/>\./);
  assert.match(output, /schema:a schema2:name "A"/);
});

test('quads added in the same tick share one prefix block', async () => {
  const chunks = [];
  const sink = { write: (chunk, encoding, done) => { chunks.push(chunk); if (done) done(); }, end: (done) => done && done() };
  const writer = new PrefixedWriter(new Writer(sink), { table: TABLE });
  writer.addQuad(q(EX + 'a', 'https://schema.org/name', df.literal('A')));
  writer.addQuad(q(EX + 'a', 'http://purl.obolibrary.org/obo/GO_0001', df.literal('B')));
  assert.equal(chunks.join(''), '', 'nothing is written before the end of the tick');
  await new Promise((resolve) => setTimeout(resolve, 5));
  const output = chunks.join('');
  assert.equal((output.match(/\n\n/g) || []).length, 1);
  assert.match(output, /^@prefix schema: .*\n@prefix go: .*\n\n<https:\/\/example\.org\/a> schema:name "A";\n    go:0001 "B"/);
  writer.end();
});

test('N-Quads output declares no prefixes', () => {
  const output = serialize([q(EX + 'a', 'https://schema.org/name', df.literal('A'))], { ex: EX }, { format: 'N-Quads' });
  assert.equal(output, '<https://example.org/a> <https://schema.org/name> "A" .\n');
});
