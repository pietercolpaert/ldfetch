'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dataModel = require('@rdfjs/data-model').default;
const { DatasetIndex, createRegistry, detectAvailable, expandHydraTemplate, extractTimeSeries, termKey } = require('../playground/visualizations');

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

test('visualization labels follow the selected language with sensible fallbacks', () => {
  const work = dataModel.namedNode('https://example.test/altarpiece');
  const title = dataModel.namedNode('http://purl.org/dc/terms/title');
  const index = new DatasetIndex();
  index.addAll([
    dataModel.quad(work, title, dataModel.literal('Lam Gods', 'nl')),
    dataModel.quad(work, title, dataModel.literal('Ghent Altarpiece', 'en'))
  ]);

  index.preferredLanguages = ['nl-be'];
  assert.equal(index.label(work), 'Lam Gods');
  index.preferredLanguages = ['en-us'];
  assert.equal(index.label(work), 'Ghent Altarpiece');
  index.preferredLanguages = ['fr'];
  assert.equal(index.label(work), 'Lam Gods');
});

test('Ghent Altarpiece JSON-LD labels are bilingual', () => {
  const file = path.join(__dirname, '../playground/examples/iiif-lam-gods-manifest.jsonld');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  const labels = [];
  function collect(value) {
    if (Array.isArray(value)) return value.forEach(collect);
    if (!value || typeof value !== 'object') return;
    if (value.label) labels.push(value.label);
    Object.values(value).forEach(collect);
  }
  collect(manifest);

  assert.ok(labels.length > 40);
  labels.forEach(label => {
    assert.ok(label.nl?.length, 'every label has a Dutch value');
    assert.ok(label.en?.length, 'every label has an English value');
  });
  assert.equal(manifest.label.en[0], 'Ghent Altarpiece (Hubert and Jan van Eyck)');
  assert.equal(manifest.items[9].label.en[0], 'The Adoration of the Mystic Lamb');
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

test('blank nodes render as bounded nested descriptions and never as entity links', () => {
  const ex = 'https://example.test/';
  const index = new DatasetIndex({ ex });
  const owner = dataModel.namedNode(ex + 'owner');
  const address = dataModel.blankNode('address');
  const nested = dataModel.blankNode('nested');
  index.addAll([
    dataModel.quad(owner, dataModel.namedNode(ex + 'address'), address),
    dataModel.quad(address, dataModel.namedNode(ex + 'street'), dataModel.literal('Main Street')),
    dataModel.quad(address, dataModel.namedNode(ex + 'nested'), nested),
    dataModel.quad(nested, dataModel.namedNode(ex + 'value'), dataModel.literal('Inside'))
  ]);

  const entities = createRegistry().find(module => module.id === 'entities');
  const html = entities.render(index, { filter: '' });
  assert.ok(html.includes('data-blank-toggle'));
  assert.ok(html.includes('Main Street'));
  assert.ok(html.includes('_:nested'));
  assert.ok(!html.includes('data-entity="BlankNode|'));
  assert.ok(!html.includes('data-select-entity="BlankNode|'));
});

test('Hydra URL templates expand filled search variables and omit empty ones', () => {
  assert.equal(
    expandHydraTemplate('https://example.test/fragments{?subject,predicate,object}', {
      subject: '<https://example.org/Alice>', predicate: '', object: 'Alice Smith'
    }),
    'https://example.test/fragments?subject=%3Chttps%3A%2F%2Fexample.org%2FAlice%3E&object=Alice%20Smith'
  );
  assert.equal(
    expandHydraTemplate('https://example.test/find?fixed=1{&term}', { term: 'two words' }),
    'https://example.test/find?fixed=1&term=two%20words'
  );
});
