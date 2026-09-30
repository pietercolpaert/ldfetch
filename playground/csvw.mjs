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

// The dialect settings rdf-parser-csvw leaves out: rows to skip (notes
// above the table, say) and how many header rows follow
function layout(dataset) {
  function value(property) {
    var dialect = Array.from(dataset.match(null, factory.namedNode(CSVW + 'dialect')))[0];
    var found = dialect && Array.from(dataset.match(dialect.object, factory.namedNode(CSVW + property)))[0];
    return found ? found.object.value : null;
  }
  var skipRows = parseInt(value('skipRows'), 10) || 0;
  var header = value('header');
  var headerRowCount = value('headerRowCount');
  return { skipRows: skipRows, headerRows: header === 'false' ? 0 : (headerRowCount !== null ? parseInt(headerRowCount, 10) || 0 : 1) };
}

// Splits raw records into skipped rows, header rows and data rows
function rowReader(settings, onHeader, onData) {
  var seen = 0;
  return function (data) {
    var position = seen++;
    if (position < settings.skipRows) return null;
    if (position < settings.skipRows + settings.headerRows) {
      if (position === settings.skipRows) onHeader(data.record);
      return null;
    }
    return onData(data);
  };
}

function csvOptions(metadata) {
  return {
    columns: false,
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
  function push(record) { var result = onRecord(record); if (result !== null) output.push(result); }
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

// The prefixes of the CSVW initial context (http://www.w3.org/ns/csvw)
var CONTEXT_PREFIXES = {
  as: 'https://www.w3.org/ns/activitystreams#',
  cc: 'http://creativecommons.org/ns#',
  csvw: 'http://www.w3.org/ns/csvw#',
  ctag: 'http://commontag.org/ns#',
  dc: 'http://purl.org/dc/terms/',
  dc11: 'http://purl.org/dc/elements/1.1/',
  dcat: 'http://www.w3.org/ns/dcat#',
  dcterms: 'http://purl.org/dc/terms/',
  dctypes: 'http://purl.org/dc/dcmitype/',
  dqv: 'http://www.w3.org/ns/dqv#',
  duv: 'https://www.w3.org/TR/vocab-duv#',
  foaf: 'http://xmlns.com/foaf/0.1/',
  gr: 'http://purl.org/goodrelations/v1#',
  grddl: 'http://www.w3.org/2003/g/data-view#',
  ical: 'http://www.w3.org/2002/12/cal/icaltzd#',
  ldp: 'http://www.w3.org/ns/ldp#',
  ma: 'http://www.w3.org/ns/ma-ont#',
  oa: 'http://www.w3.org/ns/oa#',
  og: 'http://ogp.me/ns#',
  org: 'http://www.w3.org/ns/org#',
  owl: 'http://www.w3.org/2002/07/owl#',
  prov: 'http://www.w3.org/ns/prov#',
  qb: 'http://purl.org/linked-data/cube#',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfa: 'http://www.w3.org/ns/rdfa#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  rev: 'http://purl.org/stuff/rev#',
  rif: 'http://www.w3.org/2007/rif#',
  rr: 'http://www.w3.org/ns/r2rml#',
  schema: 'http://schema.org/',
  sd: 'http://www.w3.org/ns/sparql-service-description#',
  sioc: 'http://rdfs.org/sioc/ns#',
  skos: 'http://www.w3.org/2004/02/skos/core#',
  skosxl: 'http://www.w3.org/2008/05/skos-xl#',
  v: 'http://rdf.data-vocabulary.org/#',
  vcard: 'http://www.w3.org/2006/vcard/ns#',
  void: 'http://rdfs.org/ns/void#',
  wdr: 'http://www.w3.org/2007/05/powder#',
  wrds: 'http://www.w3.org/2007/05/powder-s#',
  xhv: 'http://www.w3.org/1999/xhtml/vocab#',
  xsd: 'http://www.w3.org/2001/XMLSchema#'
};

// A URI template property is expanded as a prefixed name of the CSVW
// initial context, or else resolved against the table's URL. rdf-parser-csvw
// 1.1.1 does neither for propertyUrl and valueUrl, which leaves IRIs such as
// schema:name, or csvcubed's relative table.csv#dimension/year.
function repairIri(term, base) {
  if (term.termType !== 'NamedNode') return term;
  var prefixed = /^([A-Za-z][\w.-]*):(?!\/\/)(.*)$/.exec(term.value);
  if (prefixed && Object.prototype.hasOwnProperty.call(CONTEXT_PREFIXES, prefixed[1])) return factory.namedNode(CONTEXT_PREFIXES[prefixed[1]] + prefixed[2]);
  if (/^[a-z][a-z0-9+.-]*:/i.test(term.value)) return term;
  try { return factory.namedNode(new URL(term.value, base).href); } catch (error) { return term; }
}

// The CSVW names of built-in datatypes that are not XSD local names
var XSD = 'http://www.w3.org/2001/XMLSchema#';
var DATATYPE_ALIASES = {
  any: XSD + 'anyAtomicType',
  binary: XSD + 'base64Binary',
  datetime: XSD + 'dateTime',
  html: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#HTML',
  json: 'http://www.w3.org/ns/csvw#JSON',
  number: XSD + 'double',
  xml: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#XMLLiteral'
};

// rdf-parser-csvw 1.1.1 gives a literal of a derived datatype (a blank node
// with a csvw:base) a datatype whose value is the base's NamedNode rather
// than its IRI, and appends a base such as "datetime" to the XSD namespace
// as is (xsd:datetime rather than xsd:dateTime)
function repairLiteral(term) {
  if (term.termType !== 'Literal' || !term.datatype) return term;
  var datatype = typeof term.datatype.value === 'string' ? term.datatype.value : term.datatype.value.value;
  var alias = datatype.indexOf(XSD) === 0 && DATATYPE_ALIASES[datatype.slice(XSD.length)];
  if (!alias && datatype === term.datatype.value) return term;
  return factory.literal(term.value, factory.namedNode(alias || datatype));
}

function repairQuad(quad, base) {
  var subject = repairIri(quad.subject, base);
  var predicate = repairIri(quad.predicate, base);
  var object = repairLiteral(repairIri(quad.object, base));
  if (subject === quad.subject && predicate === quad.predicate && object === quad.object) return quad;
  return factory.quad(subject, predicate, object, quad.graph);
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
    push(quad) { if (quad) captured.push(repairQuad(quad, options.url)); return true; }
  }
  var rows = new Rows({ baseIRI: options.url, factory: factory, metadata: metadata });
  var tableMessage = captured;
  // rdf-parser-csvw reads a cell by its column's title, URI templates by its
  // column's name, so key each cell by both. Which cell belongs to which
  // column follows the header when it has every described column, in order
  // for repeated titles (a CSV file may have more columns than described),
  // and their position otherwise, as CSVW itself does. Undescribed cells
  // keep their header title.
  var columns = metadata.tableSchemas[0].parsedColumns.filter(function (column) { return column.virtual !== 'true'; });
  columns.forEach(function (column) { if (!column.titles.length) column.titles = [column.name]; });
  var header = [];
  var cellColumns = null;
  function assignColumns() {
    var used = {};
    var found = columns.map(function (column) {
      var position = header.findIndex(function (cell, index) {
        return !used[index] && (column.titles.indexOf(cell) !== -1 || cell === column.name);
      });
      if (position !== -1) used[position] = true;
      return position;
    });
    var byHeader = header.length > 0 && found.every(function (position) { return position !== -1; });
    var assigned = [];
    columns.forEach(function (column, index) { assigned[byHeader ? found[index] : index] = column; });
    return assigned;
  }
  var csv = incrementalCsv(csvOptions(metadata), rowReader(layout(metadata.dataset), function (record) { header = record; }, function (data) {
    if (!cellColumns) cellColumns = assignColumns();
    var row = {};
    data.record.forEach(function (cell, position) {
      var column = cellColumns[position];
      if (!column) { row[header[position] || '_col.' + (position + 1)] = cell; return; }
      row[column.titles[0]] = cell;
      if (column.name) row[column.name] = cell;
    });
    captured = [];
    rows.processRow(data.info.lines, row);
    return captured;
  }));
  return { tableMessage: tableMessage, write: csv.write, end: csv.end };
}

// Reads the header and at most `limit` rows from a ReadableStream reader of
// the CSV file, cancelling the download once it has them
export function previewRows(reader, options) {
  var metadata = parseMetadata(tableMetadata(options.quads, options.table), { baseIRI: options.url, factory: factory });
  var limit = options.limit || 1000;
  var settings = layout(metadata.dataset);
  var header = [];
  var rows = [];
  var csv = incrementalCsv(csvOptions(metadata), rowReader(settings, function (record) { header = record; }, function (data) { return data.record; }));
  function result(complete) {
    return { header: header, rows: rows.slice(0, limit), complete: complete, skippedRows: settings.skipRows, headerRows: settings.headerRows };
  }
  function step() {
    if (rows.length > limit) {
      reader.cancel().catch(function () {});
      return Promise.resolve(result(false));
    }
    return reader.read().then(function (read) {
      rows = rows.concat(read.done ? csv.end() : csv.write(read.value));
      return read.done ? result(rows.length <= limit) : step();
    });
  }
  return step();
}
