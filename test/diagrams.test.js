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

const RML_PREFIXES = '@prefix rr: <http://www.w3.org/ns/r2rml#>. @prefix rml: <http://semweb.mmlab.be/ns/rml#>. @prefix ql: <http://semweb.mmlab.be/ns/ql#>. ' +
  '@prefix fnml: <http://semweb.mmlab.be/ns/fnml#>. @prefix fno: <https://w3id.org/function/ontology#>. @prefix grel: <http://users.ugent.be/~bjdmeest/function/grel.ttl#>. ' +
  '@prefix foaf: <http://xmlns.com/foaf/0.1/>.\n';

test('the RML overview draws untyped triples maps, their shared source, and joins', async () => {
  const index = await indexOf(RML_PREFIXES +
    'ex:Person rml:logicalSource [ rml:source "people.json"; rml:iterator "$.[*]"; rml:referenceFormulation ql:JSONPath ]; ' +
    '  rr:subjectMap [ rr:template "https://example.org/person/{id}"; rr:class foaf:Person ]; ' +
    '  rr:predicateObjectMap [ rr:predicate foaf:name; rr:objectMap [ rml:reference "$.name"; rr:language "en" ] ], ' +
    '    [ rr:predicate foaf:based_near; rr:objectMap [ rr:parentTriplesMap ex:City; rr:joinCondition [ rr:child "city"; rr:parent "id" ] ] ]. ' +
    'ex:City rml:logicalSource [ rml:source "people.json"; rml:iterator "$.[*]"; rml:referenceFormulation ql:JSONPath ]; ' +
    '  rr:subjectMap [ rr:template "https://example.org/city/{city}" ].');
  assert.deepEqual(diagrams.rmlTriplesMaps(index).map((entity) => entity.term.value).sort(), ['https://example.org/City', 'https://example.org/Person']);
  const diagram = diagrams.rmlDiagram(index, termKey);
  const idOf = (iri) => Object.keys(diagram.links).find((id) => diagram.links[id] === 'NamedNode|' + iri);
  const [person, city] = [idOf('https://example.org/Person'), idOf('https://example.org/City')];
  const source = diagram.source;
  assert.match(source, /^classDiagram\n/);
  assert.ok(source.includes(`${person} : subject https#58;//example.org/person/#123;id#125;`), 'templates keep their braces as entity codes');
  assert.ok(source.includes(`${person} : a Person`), 'IRIs are shortened with the known prefixes only');
  assert.ok(source.includes(`${person} : name #123;#36;.name#125;@en`), 'a reference, with its language');
  assert.ok(source.includes(`${person} --> ${city} : based_near #91;city = id#93;`), 'a join with its condition');
  const sources = source.split('\n').filter((line) => line.endsWith('"people.json"]'));
  assert.equal(sources.length, 1, 'two identical blank-node logical sources are drawn once');
  const sourceId = /class (C\d+)/.exec(sources[0])[1];
  assert.ok(source.includes(`${sourceId} ..> ${person}`) && source.includes(`${sourceId} ..> ${city}`));
  assert.ok(source.includes(`<<source>> ${sourceId}`));
});

test('the RML overview draws FnML function values as functions, not triples maps', async () => {
  const index = await indexOf(RML_PREFIXES +
    'ex:Map a rr:TriplesMap; rml:logicalSource ex:Source; rr:subjectMap [ rr:template "{id}" ]; ' +
    '  rr:predicateObjectMap [ rr:predicateMap [ rr:constant foaf:name ]; rr:objectMap [ fnml:functionValue ex:Upper ] ]. ' +
    'ex:Source rml:source "data.csv"; rml:referenceFormulation ql:CSV. ' +
    'ex:Upper rml:logicalSource ex:Source; ' +
    '  rr:predicateObjectMap [ rr:predicate fno:executes; rr:objectMap [ rr:constant grel:toUpperCase ] ], ' +
    '    [ rr:predicate grel:valueParameter; rr:objectMap [ rml:reference "name" ] ].');
  assert.deepEqual(diagrams.rmlTriplesMaps(index).map((entity) => entity.term.value), ['https://example.org/Map']);
  const diagram = diagrams.rmlDiagram(index, termKey);
  const idOf = (iri) => Object.keys(diagram.links).find((id) => diagram.links[id] === 'NamedNode|' + iri);
  const [map, upper] = [idOf('https://example.org/Map'), idOf('https://example.org/Upper')];
  assert.ok(diagram.source.includes(`class ${upper}["toUpperCase"]`));
  assert.ok(diagram.source.includes(`<<function>> ${upper}`));
  assert.ok(diagram.source.includes(`${upper} : valueParameter #123;name#125;`));
  assert.ok(diagram.source.includes(`${map} : name ƒ toUpperCase`), 'a predicate map constant, and the function call');
  assert.ok(diagram.source.includes(`${upper} ..> ${map}`));
});

test('the RML overview understands RML-Core and RML-FNML', async () => {
  const index = await indexOf('@prefix rml: <http://w3id.org/rml/>. @prefix foaf: <http://xmlns.com/foaf/0.1/>. @prefix idlab-fn: <https://w3id.org/imec/idlab/function#>.\n' +
    'ex:Map a rml:TriplesMap; rml:logicalSource [ rml:source [ rml:path "people.csv" ]; rml:referenceFormulation rml:CSV ]; ' +
    '  rml:subjectMap [ rml:template "{id}"; rml:termType rml:BlankNode ]; ' +
    '  rml:predicateObjectMap [ rml:predicate foaf:mbox; rml:objectMap [ rml:functionExecution [ rml:function idlab-fn:toLowerCase; ' +
    '    rml:input [ rml:parameter idlab-fn:str; rml:inputValueMap [ rml:reference "email" ] ] ] ] ].');
  const diagram = diagrams.rmlDiagram(index, termKey);
  assert.ok(diagram.source.includes('"people.csv"]'), 'the path of a source description');
  assert.ok(diagram.source.includes(' : subject _#58;#123;id#125;'), 'a blank node subject');
  assert.ok(diagram.source.includes('["toLowerCase"]'));
  assert.ok(diagram.source.includes(' : str #123;email#125;\n'));
  assert.ok(diagram.source.includes(' : mbox ƒ toLowerCase\n'));
});

test('the RML overview is left out without triples maps', async () => {
  assert.equal(diagrams.rmlDiagram(await indexOf('ex:a ex:b ex:c.'), termKey), null);
});

test('the RML overview draws one source per file, with differing iterators on its arrows', async () => {
  const index = await indexOf(RML_PREFIXES +
    'ex:Room rml:logicalSource [ rml:source "hotel.json"; rml:iterator "$[?(@.type == \'room\')]"; rml:referenceFormulation ql:JSONPath ]; rr:subjectMap [ rr:template "room/{id}" ]. ' +
    'ex:Sensor rml:logicalSource [ rml:source "hotel.json"; rml:iterator "$[?(@.type == \'sensor\')]"; rml:referenceFormulation ql:JSONPath ]; rr:subjectMap [ rr:template "sensor/{id}" ].');
  const diagram = diagrams.rmlDiagram(index, termKey);
  const sources = diagram.source.split('\n').filter((line) => line.endsWith('"hotel.json"]'));
  assert.equal(sources.length, 1);
  const sourceId = /class (C\d+)/.exec(sources[0])[1];
  assert.equal(diagram.source.includes(`${sourceId} : iterator`), false);
  assert.ok(diagram.source.includes(`${sourceId} ..> `) && diagram.source.includes(' : #36;#91;?#40;@.type == #39;room#39;#41;#93;\n'));
});
