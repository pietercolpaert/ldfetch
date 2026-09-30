'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const RdfParsers = require('../lib/RdfParsers.js');
const { DatasetIndex, csvwTables } = require('../playground/visualizations');

const CSVW = 'http://www.w3.org/ns/csvw#';

// The JSON-LD @context is inlined (the part of the CSVW context used here),
// so that parsing needs no network
const CONTEXT = {
  csvw: CSVW, xsd: 'http://www.w3.org/2001/XMLSchema#', schema: 'http://schema.org/',
  url: { '@id': 'csvw:url', '@type': 'xsd:anyURI' },
  tables: { '@id': 'csvw:table', '@type': '@id', '@container': '@set' },
  tableSchema: { '@id': 'csvw:tableSchema', '@type': '@id' },
  columns: { '@id': 'csvw:column', '@type': '@id', '@container': '@list' },
  name: { '@id': 'csvw:name', '@type': 'xsd:string' },
  titles: { '@id': 'csvw:title', '@container': '@set' },
  aboutUrl: { '@id': 'csvw:aboutUrl', '@type': 'csvw:uriTemplate' },
  propertyUrl: { '@id': 'csvw:propertyUrl', '@type': 'csvw:uriTemplate' },
  datatype: { '@id': 'csvw:datatype', '@type': '@vocab' },
  base: { '@id': 'csvw:base', '@type': 'xsd:string' },
  integer: 'xsd:integer'
};

const METADATA = {
  '@context': CONTEXT,
  tables: [{
    url: 'people.csv',
    'schema:name': 'People',
    tableSchema: {
      aboutUrl: 'https://example.org/person/{id}',
      columns: [
        { name: 'id', titles: ['id'], datatype: 'integer' },
        { name: 'name', titles: ['name'], propertyUrl: 'http://schema.org/name' },
        { name: 'contact', titles: ['contact'], propertyUrl: 'http://schema.org/email', datatype: { base: 'string' } }
      ]
    }
  }]
};

function parse (json) {
  return new Promise((resolve, reject) => {
    const quads = [];
    RdfParsers.parse({ bodyText: JSON.stringify(json), contentType: 'application/csvm+json', baseIRI: 'https://example.org/people.csv-metadata.json' })
      .on('data', (quad) => quads.push(quad)).on('error', reject).on('end', () => resolve(quads));
  });
}

function indexOf (quads) {
  const index = new DatasetIndex({});
  index.addAll(quads);
  return index;
}

test('CSVW metadata is parsed as JSON-LD, and its tables are found, also through a table group', async () => {
  const quads = await parse(METADATA);
  const tables = csvwTables(indexOf(quads));
  assert.equal(tables.length, 1);
  assert.equal(tables[0].url, 'people.csv');
  assert.ok(tables[0].group, 'the table group the table belongs to');
});

test('converted CSV2RDF output is not mistaken for a CSVW description', () => {
  const table = { termType: 'BlankNode', value: 't' };
  const quad = (subject, predicate, object) => ({ subject, predicate: { termType: 'NamedNode', value: predicate }, object, graph: { termType: 'DefaultGraph', value: '' } });
  const index = indexOf([
    quad(table, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', { termType: 'NamedNode', value: CSVW + 'Table' }),
    quad(table, CSVW + 'url', { termType: 'NamedNode', value: 'https://example.org/people.csv' })
  ]);
  assert.deepEqual(csvwTables(index), []);
});

test('CSV2RDF gives a table message, then one message per row, fed in arbitrary chunks', async () => {
  const quads = await parse(METADATA);
  const [table] = csvwTables(indexOf(quads));
  const { createConverter } = await import('../playground/csvw.mjs');
  const converter = createConverter({ quads, table: table.entity.term, url: 'https://example.org/people.csv' });
  assert.ok(converter.tableMessage.some((quad) => quad.object.value === CSVW + 'Table'));
  assert.ok(converter.tableMessage.some((quad) => quad.predicate.value === 'http://schema.org/name' && quad.object.value === 'People'), 'table metadata is copied');
  const bytes = new TextEncoder().encode('id,name,contact\n1,Alice,alice@example.org\n2,"Bob, Jr.",bob@example.org\n');
  const messages = [];
  // Split within a record, and within a quoted field
  [bytes.slice(0, 20), bytes.slice(20, 48), bytes.slice(48)].forEach((chunk) => messages.push(...converter.write(chunk)));
  messages.push(...converter.end());
  assert.equal(messages.length, 2);
  const names = messages.map((message) => message.find((quad) => quad.predicate.value === 'http://schema.org/name'));
  assert.deepEqual(names.map((quad) => [quad.subject.value, quad.object.value]), [['https://example.org/person/1', 'Alice'], ['https://example.org/person/2', 'Bob, Jr.']]);
  const email = messages[0].find((quad) => quad.predicate.value === 'http://schema.org/email');
  assert.equal(email.object.datatype.value, 'http://www.w3.org/2001/XMLSchema#string', 'a derived datatype has its base as an IRI');
  assert.ok(messages[1].some((quad) => quad.predicate.value === CSVW + 'rownum' && quad.object.value === '2'));
});

test('the preview reads the header and at most the requested rows, then cancels the download', async () => {
  const quads = await parse(METADATA);
  const [table] = csvwTables(indexOf(quads));
  const { previewRows } = await import('../playground/csvw.mjs');
  let cancelled = false;
  const chunks = ['id,name,contact\n', '1,Alice,a\n2,Bob,b\n', '3,Carol,c\n4,Dave,d\n', '5,Eve,e\n', '6,Frank,f\n', '7,Grace,g\n'].map((text) => new TextEncoder().encode(text));
  const reader = {
    read: () => Promise.resolve(chunks.length ? { done: false, value: chunks.shift() } : { done: true }),
    cancel: () => { cancelled = true; return Promise.resolve(); }
  };
  const preview = await previewRows(reader, { quads, table: table.entity.term, url: 'https://example.org/people.csv', limit: 3 });
  assert.deepEqual(preview.header, ['id', 'name', 'contact']);
  assert.deepEqual(preview.rows.map((row) => row[1]), ['Alice', 'Bob', 'Carol']);
  assert.equal(preview.complete, false);
  assert.equal(cancelled, true);
  assert.ok(chunks.length > 0, 'the rest of the file is never read');
});

test('CSV2RDF skips the rows above the table and extra header rows, and matches columns by position', async () => {
  const metadata = {
    '@context': Object.assign({ dialect: { '@id': 'csvw:dialect', '@type': '@id' }, skipRows: { '@id': 'csvw:skipRows' }, headerRowCount: { '@id': 'csvw:headerRowCount' } }, CONTEXT),
    url: 'weather.csv',
    dialect: { skipRows: 2, headerRowCount: 2 },
    tableSchema: {
      aboutUrl: 'https://example.org/record/{year}',
      columns: [
        { name: 'year', titles: ['Year'] },
        { name: 'rain', titles: ['Rainfall'], propertyUrl: 'https://example.org/rain' }
      ]
    }
  };
  const quads = await parse(metadata);
  const [table] = csvwTables(indexOf(quads));
  const { createConverter, previewRows } = await import('../playground/csvw.mjs');
  const csv = 'Weather station,\nEstimated values are marked,\nyyyy,rain\n,mm\n1978,26.7\n1979,20.4\n';
  const converter = createConverter({ quads, table: table.entity.term, url: 'https://example.org/weather.csv' });
  const messages = converter.write(new TextEncoder().encode(csv)).concat(converter.end());
  assert.equal(messages.length, 2, 'only the data rows');
  const rain = messages.map((message) => message.find((quad) => quad.predicate.value === 'https://example.org/rain'));
  assert.deepEqual(rain.map((quad) => [quad.subject.value, quad.object.value]), [['https://example.org/record/1978', '26.7'], ['https://example.org/record/1979', '20.4']],
    'the header says yyyy and rain rather than the titles, and templates use column names');
  const chunks = [new TextEncoder().encode(csv)];
  const reader = { read: () => Promise.resolve(chunks.length ? { done: false, value: chunks.shift() } : { done: true }), cancel: () => Promise.resolve() };
  const preview = await previewRows(reader, { quads, table: table.entity.term, url: 'https://example.org/weather.csv' });
  assert.deepEqual(preview.header, ['yyyy', 'rain']);
  assert.deepEqual(preview.rows, [['1978', '26.7'], ['1979', '20.4']]);
  assert.equal(preview.skippedRows, 2);
  assert.equal(preview.headerRows, 2);
});
