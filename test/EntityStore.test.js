'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const EntityStore = require('../lib/EntityStore.js');

test('EntityStore stores triples without a graph by subject and predicate', () => {
  const store = new EntityStore();

  store.addTriple({
    subject: 'https://example.org/alice',
    predicate: 'http://xmlns.com/foaf/0.1/name',
    object: 'Alice'
  });

  assert.deepEqual(store.getTriples(), {
    'https://example.org/alice': {
      'http://xmlns.com/foaf/0.1/name': 'Alice'
    }
  });
});

test('EntityStore stores triples with a graph by graph, subject and predicate', () => {
  const store = new EntityStore();

  store.addTriple({
    graph: 'https://example.org/graph',
    subject: 'https://example.org/bob',
    predicate: 'http://xmlns.com/foaf/0.1/name',
    object: 'Bob'
  });

  assert.deepEqual(store.getTriples(), {
    'https://example.org/graph': {
      'https://example.org/bob': {
        'http://xmlns.com/foaf/0.1/name': 'Bob'
      }
    }
  });
});

test('EntityStore stores individual prefixes and bulk prefixes', () => {
  const store = new EntityStore();

  store.addPrefix('schema', 'https://schema.org/');
  store.addPrefixes(new Map([
    ['foaf', 'http://xmlns.com/foaf/0.1/']
  ]));
  store.addPrefixes({
    hydra: 'http://www.w3.org/ns/hydra/core#'
  });

  assert.deepEqual(store.prefixes, {
    schema: 'https://schema.org/',
    foaf: 'http://xmlns.com/foaf/0.1/',
    hydra: 'http://www.w3.org/ns/hydra/core#'
  });
});

test('EntityStore.addTriples stores each supplied triple', () => {
  const store = new EntityStore();

  store.addTriples([
    { subject: 's1', predicate: 'p1', object: 'o1' },
    { subject: 's2', predicate: 'p2', object: 'o2' }
  ]);

  assert.deepEqual(store.getTriples(), {
    s1: { p1: 'o1' },
    s2: { p2: 'o2' }
  });
});