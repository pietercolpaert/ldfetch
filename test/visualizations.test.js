'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dataModel = require('@rdfjs/data-model').default;
const { DatasetIndex, createRegistry, detectAvailable, extractTimeSeries, termKey } = require('../playground/visualizations');

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const FOAF = 'http://xmlns.com/foaf/0.1/';
const SH = 'http://www.w3.org/ns/shacl#';
const TSS = 'https://w3id.org/tss#';

test('visualization index preserves repeated values, incoming links, and graph identity', () => {
  const alice = dataModel.namedNode('https://example.test/alice');
  const bob = dataModel.namedNode('https://example.test/bob');
  const knows = dataModel.namedNode(FOAF + 'knows');
  const graphA = dataModel.namedNode('https://example.test/graph/a');
  const graphB = dataModel.namedNode('https://example.test/graph/b');
  const index = new DatasetIndex({ foaf: FOAF });

  index.add(dataModel.quad(alice, knows, bob, graphA));
  index.add(dataModel.quad(alice, knows, dataModel.namedNode('https://example.test/charlie'), graphB));
  index.add(dataModel.quad(alice, knows, bob, graphB));

  assert.equal(index.quads.length, 3, 'duplicate statements in distinct graphs remain present');
  assert.equal(index.values(alice, FOAF + 'knows').length, 2, 'the property remains multivalued');
  assert.equal(index.entity(alice).properties.get(FOAF + 'knows').length, 3, 'raw per-property evidence retains repeated objects');
  assert.equal(index.incoming.get(termKey(bob)).length, 2, 'both incoming statements remain available');
  assert.equal(index.graphs.size, 2);
});

test('registry progressively detects profile, SHACL, temporal, and numeric views', () => {
  const ex = 'https://example.test/';
  const alice = dataModel.namedNode(ex + 'alice');
  const shape = dataModel.namedNode(ex + 'PersonShape');
  const property = dataModel.namedNode(ex + 'nameProperty');
  const index = new DatasetIndex({ ex, foaf: FOAF, sh: SH });

  index.addAll([
    dataModel.quad(alice, dataModel.namedNode(RDF + 'type'), dataModel.namedNode(FOAF + 'Person')),
    dataModel.quad(alice, dataModel.namedNode(FOAF + 'name'), dataModel.literal('Alice')),
    dataModel.quad(alice, dataModel.namedNode(ex + 'score'), dataModel.literal('2', dataModel.namedNode(XSD + 'decimal'))),
    dataModel.quad(dataModel.namedNode(ex + 'bob'), dataModel.namedNode(ex + 'score'), dataModel.literal('5', dataModel.namedNode(XSD + 'decimal'))),
    dataModel.quad(alice, dataModel.namedNode(ex + 'at'), dataModel.literal('2026-09-07T09:00:00Z', dataModel.namedNode(XSD + 'dateTime'))),
    dataModel.quad(dataModel.namedNode(ex + 'bob'), dataModel.namedNode(ex + 'at'), dataModel.literal('2026-09-07T10:00:00Z', dataModel.namedNode(XSD + 'dateTime'))),
    dataModel.quad(shape, dataModel.namedNode(RDF + 'type'), dataModel.namedNode(SH + 'NodeShape')),
    dataModel.quad(shape, dataModel.namedNode(SH + 'property'), property),
    dataModel.quad(property, dataModel.namedNode(SH + 'path'), dataModel.namedNode(FOAF + 'name'))
  ]);

  const ids = detectAvailable(index, createRegistry()).map(item => item.module.id);
  assert.ok(ids.includes('profiles'));
  assert.ok(ids.includes('shapes'));
  assert.ok(ids.includes('forms'));
  assert.ok(ids.includes('timeline'));
  assert.ok(ids.includes('statistics'));
  assert.ok(ids.includes('relationships'));
  assert.ok(ids.includes('overview'));
});

test('RDF TSS JSON subpoints become ordered time-series points', () => {
  const snippet = dataModel.namedNode('https://example.test/snippet');
  const index = new DatasetIndex({ tss: TSS });
  index.add(dataModel.quad(snippet, dataModel.namedNode(TSS + 'points'), dataModel.literal(JSON.stringify([
    { time: '2020-11-07T12:15:00Z', value: '29.66', id: 'stage-1215', observedProperty: 'River Stage' },
    { time: '2020-11-07T12:00:00Z', value: '29.64', id: 'stage-1200', observedProperty: 'River Stage' }
  ]))));
  index.add(dataModel.quad(dataModel.namedNode('https://example.test/broken'), dataModel.namedNode(TSS + 'points'), dataModel.literal('[not json')));

  const series = extractTimeSeries(index);
  assert.equal(series.length, 1);
  assert.equal(series[0].label, 'River Stage');
  assert.deepEqual(series[0].points.map(point => point.pointId), ['stage-1200', 'stage-1215']);
  assert.equal(series[0].points[1].value, 29.66);
});
