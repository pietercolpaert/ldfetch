'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const RdfParsers = require('../lib/RdfParsers.js');
const { DatasetIndex, termKey } = require('../playground/visualizations');
const diagrams = require('../playground/diagrams');

const PREFIXES = '@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>. @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#>. ' +
  '@prefix owl: <http://www.w3.org/2002/07/owl#>. @prefix xsd: <http://www.w3.org/2001/XMLSchema#>. @prefix sh: <http://www.w3.org/ns/shacl#>. ' +
  '@prefix ex: <https://example.org/>.\n';

function indexOf (turtle) {
  return new Promise((resolve, reject) => {
    const index = new DatasetIndex({ ex: 'https://example.org/', xsd: 'http://www.w3.org/2001/XMLSchema#' });
    RdfParsers.parse({ bodyText: PREFIXES + turtle, contentType: 'text/turtle', baseIRI: 'https://example.org/' })
      .on('data', (quad) => index.add(quad))
      .on('error', reject)
      .on('end', () => resolve(index));
  });
}

// ShapesGraph is an ES module outside extract-cbd-shape's exports; the
// playground bundle requires it, Node.js 20 can only import() it
async function shapesGraphModules () {
  const dist = path.join(__dirname, '..', 'node_modules', 'extract-cbd-shape', 'dist', 'lib');
  const { ShapesGraph } = await import(pathToFileURL(path.join(dist, 'ShapesGraph.js')));
  const { createGraphIndexedRdfStore } = await import(pathToFileURL(path.join(dist, 'Utils.js')));
  return { ShapesGraph, createStore: createGraphIndexedRdfStore };
}

test('the ontology overview draws subclasses, object properties and datatype properties', async () => {
  const index = await indexOf(
    'ex:Agent a owl:Class. ex:Person a owl:Class; rdfs:subClassOf ex:Agent. ' +
    'ex:knows a owl:ObjectProperty; rdfs:domain ex:Person; rdfs:range ex:Person. ' +
    'ex:memberOf a owl:ObjectProperty; rdfs:domain ex:Person; rdfs:range ex:Group. ' +
    'ex:name a owl:DatatypeProperty; rdfs:domain ex:Agent; rdfs:range xsd:string.');
  const diagram = diagrams.ontologyDiagram(index, termKey);
  const idOf = (iri) => Object.keys(diagram.links).find((id) => diagram.links[id] === 'NamedNode|' + iri);
  const [agent, person, group] = ['Agent', 'Person', 'Group'].map((name) => idOf('https://example.org/' + name));
  assert.match(diagram.source, /^classDiagram\n/);
  assert.ok(diagram.source.includes(`class ${person}["ex:Person"]`));
  assert.ok(diagram.source.includes(`${agent} <|-- ${person}`), 'subclass arrow points to the superclass');
  assert.ok(diagram.source.includes(`${person} --> ${person} : ex#58;knows`), 'colons in labels are entity-encoded');
  assert.ok(diagram.source.includes(`${agent} : +ex#58;name xsd#58;string`), 'datatype property as attribute');
  assert.ok(diagram.source.includes(`<<external>> ${group}`), 'a range outside the loaded classes is marked external');
  assert.equal(diagram.truncated, false);
});

test('the ontology overview is left out without classes', async () => {
  assert.equal(diagrams.ontologyDiagram(await indexOf('ex:a ex:b ex:c.'), termKey), null);
});

test('shape topologies come from extract-cbd-shape, one per root shape, with prefixed names', async () => {
  const index = await indexOf(
    'ex:PersonShape a sh:NodeShape; rdfs:label "Person"; sh:property [ sh:path ex:name; sh:minCount 1 ], [ sh:path ex:address; sh:node ex:AddressShape ]. ' +
    'ex:AddressShape a sh:NodeShape; rdfs:label "Address"; sh:property [ sh:path ex:street ].');
  const { ShapesGraph, createStore } = await shapesGraphModules();
  const topologies = await diagrams.shapeTopologies(index, ShapesGraph, createStore);
  assert.deepEqual(topologies.map((item) => item.shape.value), ['https://example.org/PersonShape'], 'AddressShape is drawn inside PersonShape');
  const source = topologies[0].source;
  assert.match(source, /^flowchart LR\n/);
  assert.match(source, /S1\(\(Person\)\)/);
  assert.match(source, /S1-->\|"ex:name"\|/, 'required path, compacted');
  assert.match(source, /S1-\.->\|"ex:address"\|S1_0\[ \]/, 'optional path to a linked node shape');
  assert.match(source, /\(\(Address\)\)/);
  assert.equal(source.includes('‎'), false);
});

test('IRIs are shortened like elsewhere in the viewer, but kept whole when that is not possible', () => {
  const index = new DatasetIndex({});
  assert.equal(diagrams.compactMermaid('S1-->|"http:‎//other.test/p"|S1_0[ ]', index), 'S1-->|"p"|S1_0[ ]');
  assert.equal(diagrams.compactMermaid('S1-->|"http:‎//other.test/"|S1_0[ ]', index), 'S1-->|"http:‎//other.test/"|S1_0[ ]');
});
