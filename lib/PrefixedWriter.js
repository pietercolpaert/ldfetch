//Wraps an N3.js Writer, or an n3.js-messages MessageWriter, so that its Turtle/TriG output only declares
//the prefixes it actually uses. Prefixes are merely *offered* through
//addPrefix() (typically straight from the parser's 'prefix' event, so they
//are known as the source streams in) and, as a fallback, looked up in a
//namespace -> label table (such as lib/prefix-cc.json). A prefix is only
//written right before the first quad that needs it. Quads added in the same
//tick -- a parser emits a whole parsed chunk at once -- are written as one
//batch, preceded by all the prefixes that batch needs, so declarations do
//not interrupt the output every few statements and share one blank line.
//
//The writer compacts an IRI with the first declared prefix whose remainder
//is a safe local name (see N3.Writer's _encodeIriOrBlank), so this mirrors
//that rule to know which IRIs still need a prefix.

var RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
var XSD = 'http://www.w3.org/2001/XMLSchema#';
//Literals the writer abbreviates, so their datatype IRI is never written
var BARE_LITERALS = {};
BARE_LITERALS[XSD + 'boolean'] = /^(?:true|false)$/;
BARE_LITERALS[XSD + 'integer'] = /^[+-]?\d+$/;
BARE_LITERALS[XSD + 'decimal'] = /^[+-]?(?:\d+\.\d*|\.\d+)$/;
BARE_LITERALS[XSD + 'double'] = /^[+-]?(?:\d+\.\d*|\.\d+|\d+)[Ee][+-]?\d+$/;

//The trailing part of an IRI that can be a local name: [A-Za-z0-9_][A-Za-z0-9_-]*
var LOCAL_NAME = /[A-Za-z0-9_][A-Za-z0-9_-]*$/;

//Whether this is an n3.js-messages MessageWriter (it writes RDF Message Logs)
function isMessageWriter (writer) {
  return typeof writer.addMessage === 'function';
}

class PrefixedWriter {
  //writer: an N3.Writer or a MessageWriter, constructed without prefixes.
  //Or a function (messages) => writer, called once the first quad or message
  //is written, with true when it belongs to an RDF Message Log (a quad tagged
  //with a messageCounter, or addMessage()) -- the output of a source that may
  //or may not be message-framed can only be told when it arrives.
  //options.table: namespace IRI -> prefix label, consulted after the offered prefixes
  //options.enabled: false for N-Triples/N-Quads output, which has no prefixes
  //options.declare(prefixes): declares newly needed prefixes (label ->
  //namespace) on the writer instead of plain writer.addPrefixes(), e.g. to
  //show them somewhere else than in the output
  constructor (writer, options) {
    options = options || {};
    this.writer = typeof writer === 'function' ? null : writer;
    this.createWriter = typeof writer === 'function' ? writer : null;
    this.enabled = options.enabled !== false;
    this.declare = options.declare || ((prefixes) => this._declareOnWriter(prefixes));
    //Prefixes declared before the writer exists
    this.undeclared = {};
    this.table = options.table || {};
    //Offered prefixes: label -> namespace, most recently offered wins
    this.offered = Object.create(null);
    //Declared prefixes, in declaration order, as the writer matches them
    this.declared = [];
    this.declaredLabels = Object.create(null);
    this.queue = [];
    this.flushTimer = null;
  }

  addPrefix (prefix, iri) {
    this.offered[prefix] = typeof iri === 'string' ? iri : iri.value;
  }

  addPrefixes (prefixes) {
    for (var prefix in prefixes) this.addPrefix(prefix, prefixes[prefix]);
  }

  //Declares, in one go, every prefix the given quads will need, so that
  //writing them afterwards does not interrupt the output with declarations
  declareFor (quads) {
    if (!this.enabled) return;
    var pending = {};
    for (var quad of quads) this._collect(quad, pending);
    this._declare(pending);
  }

  //Accepts an RDF/JS quad or a { quad, messageCounter } entry, like
  //Writer#addQuad. It is written at the end of the current tick, or earlier
  //when flush(), addMessage() or end() is called.
  addQuad (quad) {
    this.queue.push(quad);
    if (this.flushTimer === null) this.flushTimer = setTimeout(() => this.flush(), 0);
  }

  addQuads (quads) {
    for (var quad of quads) this.addQuad(quad);
  }

  flush () {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    var quads = this.queue;
    if (!quads.length) return;
    this.queue = [];
    this._ensureWriter(quads[0].messageCounter !== undefined && !!quads[0].quad);
    this.declareFor(quads.map((quad) => quad.quad || quad));
    for (var item of quads) {
      var quad = item.quad || item;
      if (isMessageWriter(this.writer)) this.writer.addQuad(quad, item.quad ? item.messageCounter : undefined);
      else this.writer.addQuad(quad);
    }
  }

  //Writes a whole message, which needs a MessageWriter
  addMessage (message, done) {
    this.flush();
    this._ensureWriter(true);
    this.declareFor(message);
    this.writer.addMessage(message, done);
  }

  end (done) {
    this.flush();
    this._ensureWriter(false);
    this.writer.end(done);
  }

  _ensureWriter (messages) {
    if (this.writer) return;
    this.writer = this.createWriter(messages);
    var undeclared = this.undeclared;
    this.undeclared = {};
    if (Object.keys(undeclared).length) this._declareOnWriter(undeclared);
  }

  _declareOnWriter (prefixes) {
    if (!this.writer) {
      Object.assign(this.undeclared, prefixes);
    } else if (isMessageWriter(this.writer)) {
      for (var prefix in prefixes) this.writer.addPrefix(prefix, prefixes[prefix]);
    } else {
      this.writer.addPrefixes(prefixes);
    }
  }

  //The declared prefixes as a label -> namespace object
  get prefixes () {
    var prefixes = {};
    for (var [namespace, label] of this.declared) prefixes[label] = namespace;
    return prefixes;
  }

  _collect (quad, pending) {
    this._collectTerm(quad.subject, pending);
    if (!(quad.predicate.termType === 'NamedNode' && quad.predicate.value === RDF_TYPE)) {
      this._collectTerm(quad.predicate, pending);
    }
    this._collectTerm(quad.object, pending);
    this._collectTerm(quad.graph, pending);
  }

  _collectTerm (term, pending) {
    if (term.termType === 'NamedNode') {
      this._collectIri(term.value, pending);
    } else if (term.termType === 'Literal') {
      var datatype = term.datatype && term.datatype.value;
      if (term.language || !datatype || datatype === XSD + 'string') return;
      if (BARE_LITERALS[datatype] && BARE_LITERALS[datatype].test(term.value)) return;
      this._collectIri(datatype, pending);
    } else if (term.termType === 'Quad') {
      this._collect(term, pending);
    }
  }

  _collectIri (iri, pending) {
    if (this._compacts(iri)) return;
    for (var namespace in pending) {
      if (compacts(iri, namespace)) return;
    }
    var candidate = this._candidate(iri, pending);
    if (candidate) pending[candidate.namespace] = candidate.label;
  }

  _compacts (iri) {
    for (var [namespace] of this.declared) {
      if (compacts(iri, namespace)) return true;
    }
    return false;
  }

  //The offered prefix for this IRI, or else the table's most specific one
  _candidate (iri, pending) {
    for (var prefix in this.offered) {
      if (compacts(iri, this.offered[prefix])) {
        return { namespace: this.offered[prefix], label: this._freeLabel(prefix, pending) };
      }
    }
    var localName = LOCAL_NAME.exec(iri);
    if (!localName) return null;
    for (var end = iri.length - 1; end >= localName.index; end--) {
      var namespace = iri.slice(0, end);
      var label = end === localName.index || iri[end - 1] === '_' || iri[end - 1] === '-' ? this.table[namespace] : undefined;
      if (label && compacts(iri, namespace)) {
        return { namespace: namespace, label: this._freeLabel(label, pending) };
      }
    }
    return null;
  }

  //A label already bound to another namespace gets a numeric suffix
  _freeLabel (label, pending) {
    var taken = Object.create(null);
    for (var namespace in pending) taken[pending[namespace]] = true;
    var alias = label;
    for (var suffix = 2; this.declaredLabels[alias] || taken[alias]; suffix++) alias = label + suffix;
    return alias;
  }

  _declare (pending) {
    var namespaces = Object.keys(pending);
    if (!namespaces.length) return;
    var prefixes = {};
    for (var namespace of namespaces) {
      prefixes[pending[namespace]] = namespace;
      this.declared.push([namespace, pending[namespace]]);
      this.declaredLabels[pending[namespace]] = true;
    }
    this.declare(prefixes);
  }
}

//Whether the writer can write iri as a prefixed name with this namespace
function compacts (iri, namespace) {
  if (iri.length <= namespace.length || !iri.startsWith(namespace)) return false;
  var localName = LOCAL_NAME.exec(iri);
  return !!localName && localName.index <= namespace.length && iri[namespace.length] !== '-';
}

module.exports = PrefixedWriter;
