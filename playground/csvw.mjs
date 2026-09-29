// CSV on the Web for the playground, bundled separately (dist/csvw.js) and
// only loaded once a CSVW metadata document is shown: previews the first
// rows of a described CSV file, and converts it to RDF with
// rdf-parser-csvw, one RDF Message per row.
//
// rdf-parser-csvw's own import() pipes Node.js streams into each other.
// Instead, its row converter (ObjectParserTransform, whose processRow()
// pushes exactly the quads of one row) is driven directly from csv-parse's
// incremental parser, so the conversion can pause between network chunks
// like the playground's other streaming sources.
import factory from '@rdfjs/data-model';
import parseMetadata from 'rdf-parser-csvw/lib/metadata/index.js';
import ObjectParserTransform from 'rdf-parser-csvw/lib/ObjectParserTransform.js';
// csv-parse's incremental API is not among its package exports
import { transform } from '../node_modules/csv-parse/lib/api/index.js';

var CSVW = 'http://www.w3.org/ns/csvw#';

function sameTerm(pattern, term) {
  return !pattern || (pattern.termType === term.termType && pattern.value === term.value);
}

// Just enough of an RDF/JS Dataset for rdf-parser-csvw's metadata parser,
// which only ever matches and iterates
function QuadList(quads) {
  this.quads = quads;
  this.size = quads.length;
}
QuadList.prototype.match = function (subject, predicate, object, graph) {
  return new QuadList(this.quads.filter(function (quad) {
    return sameTerm(subject, quad.subject) && sameTerm(predicate, quad.predicate) && sameTerm(object, quad.object) && sameTerm(graph, quad.graph);
  }));
};
QuadList.prototype[Symbol.iterator] = function () {
  return this.quads[Symbol.iterator]();
};

// The description of a term, following blank nodes
function describe(quads, term, seen, into) {
  seen = seen || {};
  into = into || [];
  var key = term.termType + '|' + term.value;
  if (seen[key]) return into;
  seen[key] = true;
  quads.forEach(function (quad) {
    if (!sameTerm(term, quad.subject)) return;
    into.push(quad);
    if (quad.object.termType === 'BlankNode') describe(quads, quad.object, seen, into);
  });
  return into;
}

// rdf-parser-csvw reads the first table schema, dialect and csvw:url it
// finds, so hand it one table's description, followed by what it inherits
// from its table group
function tableMetadata(quads, table) {
  var own = describe(quads, table);
  var group = quads.find(function (quad) { return quad.predicate.value === CSVW + 'table' && sameTerm(table, quad.object); });
  if (group) {
    quads.forEach(function (quad) {
      if (sameTerm(group.subject, quad.subject) && [CSVW + 'tableSchema', CSVW + 'dialect'].indexOf(quad.predicate.value) !== -1) {
        own.push(quad);
        if (quad.object.termType === 'BlankNode') describe(quads, quad.object, {}, own);
      }
    });
  }
  return new QuadList(own);
}

function csvOptions(metadata, columns) {
  return {
    columns: columns,
    info: true,
    bom: true,
    delimiter: metadata.delimiter,
    quote: metadata.quoteChar,
    record_delimiter: metadata.lineTerminators || [],
    ltrim: metadata.trim === 'start' || metadata.trim === 'true',
    rtrim: metadata.trim === 'end' || metadata.trim === 'true',
    relax_column_count: true
  };
}

// Feeds byte chunks to csv-parse, collecting what onRecord makes of each
// record; write() and end() return what the chunk completed
function incrementalCsv(options, onRecord) {
  var parser = transform(options);
  var output = [];
  function push(record) { output.push(onRecord(record)); }
  function run(chunk, end) {
    output = [];
    var error = parser.parse(chunk, end, push, function () {});
    if (error) throw error;
    return output;
  }
  return {
    write: function (bytes) { return run(Buffer.from(bytes), false); },
    end: function () { return run(undefined, true); }
  };
}

// rdf-parser-csvw 1.1.1 gives a literal of a derived datatype (a blank node
// with a csvw:base) a datatype whose value is the base's NamedNode rather
// than its IRI
function repairDatatype(quad) {
  var object = quad.object;
  if (object.termType !== 'Literal' || !object.datatype || typeof object.datatype.value === 'string') return quad;
  return factory.quad(quad.subject, quad.predicate, factory.literal(object.value, factory.namedNode(object.datatype.value.value)), quad.graph);
}

// Converts a CSV file to RDF Messages: first one describing the table (and
// its table group), then one per row, with the quads rdf-parser-csvw emits
// in standard mode. `table` is the csvw:Table node in the metadata quads,
// `url` the resolved location of its CSV file.
export function createConverter(options) {
  var metadata = parseMetadata(tableMetadata(options.quads, options.table), { baseIRI: options.url, factory: factory });
  var captured = [];
  // ObjectParserTransform describes the table from its constructor
  // onwards, so capture from the start rather than after super()
  class Rows extends ObjectParserTransform {
    push(quad) { if (quad) captured.push(repairDatatype(quad)); return true; }
  }
  var rows = new Rows({ baseIRI: options.url, factory: factory, metadata: metadata });
  var tableMessage = captured;
  var csv = incrementalCsv(csvOptions(metadata, true), function (data) {
    captured = [];
    rows.processRow(data.info.lines, data.record);
    return captured;
  });
  return { tableMessage: tableMessage, write: csv.write, end: csv.end };
}

// Reads the header and at most `limit` rows from a ReadableStream reader of
// the CSV file, cancelling the download once it has them
export function previewRows(reader, options) {
  var metadata = parseMetadata(tableMetadata(options.quads, options.table), { baseIRI: options.url, factory: factory });
  var limit = options.limit || 1000;
  var records = [];
  var csv = incrementalCsv(csvOptions(metadata, false), function (data) { return data.record; });
  function step() {
    if (records.length > limit) {
      reader.cancel().catch(function () {});
      return Promise.resolve({ header: records[0], rows: records.slice(1, limit + 1), complete: false });
    }
    return reader.read().then(function (result) {
      records = records.concat(result.done ? csv.end() : csv.write(result.value));
      if (result.done) return { header: records[0] || [], rows: records.slice(1, limit + 1), complete: records.length <= limit + 1 };
      return step();
    });
  }
  return step();
}
