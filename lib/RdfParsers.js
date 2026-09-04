const { EventEmitter } = require('events');

// setImmediate is Node-only; this deferral needs to work in the browser
// bundle too, so schedule via a microtask instead.
function defer (fn) {
  Promise.resolve().then(fn);
}

/**
 * Dispatches parsing to a dedicated streaming parser per content type,
 * replacing the Comunica-based rdf-parse. Each branch lazily requires its
 * parser package so consumers that never touch a given format (e.g.
 * rdfjs-jelly, which needs Node >=24) never pay for or fail on loading it.
 *
 * Returns an EventEmitter emitting a normalized contract regardless of the
 * underlying parser:
 *   'prefix' (prefix, iriString)      -- whenever the source declares one
 *   'data'   (quad)                   -- one RDF/JS quad, always unwrapped
 *   'message' (quad[])                -- one complete RDF Message, only for
 *                                         formats/documents that actually use
 *                                         RDF Message framing (Turtle/TriG/
 *                                         N-Quads/N-Triples "-messages"
 *                                         versions, and Jelly-RDF, which is
 *                                         inherently message-framed)
 *   'error' (error)
 *   'end'   ()
 */
function baseContentType (contentType) {
  return (contentType || '').split(';')[0].trim().toLowerCase();
}

// Groups a parser's raw 'data' output into RDF Messages when the parser
// wraps items as `{ quad, messageCounter }` (rdf-parser-ts's convention).
// Plain (unwrapped) quads pass straight through without ever triggering a
// 'message' event, so ordinary, non-message documents behave exactly as
// before.
function relayMessageAwareStream (source, emitter) {
  var currentMessage = null;
  var currentCounter = null;
  var sawMessageWrapping = false;

  function flush () {
    if (sawMessageWrapping && currentMessage) {
      emitter.emit('message', currentMessage);
    }
    currentMessage = null;
  }

  source.on('prefix', function (prefix, iri) {
    emitter.emit('prefix', prefix, (iri && iri.value !== undefined) ? iri.value : iri);
  });
  source.on('data', function (item) {
    var quad = item;
    if (item && item.quad && typeof item.messageCounter === 'number') {
      sawMessageWrapping = true;
      quad = item.quad;
      if (currentCounter !== item.messageCounter) {
        flush();
        currentMessage = [];
        currentCounter = item.messageCounter;
      }
      currentMessage.push(quad);
    }
    emitter.emit('data', quad);
  });
  source.on('error', function (error) { emitter.emit('error', error); });
  source.on('end', function () {
    flush();
    emitter.emit('end');
  });
}

function parseTurtleFamily (bodyText, options, emitter) {
  const { StreamParser } = require('rdf-parser-ts');
  var parser = new StreamParser({ baseIRI: options.baseIRI, format: options.contentType });
  relayMessageAwareStream(parser, emitter);
  parser.write(bodyText);
  parser.end();
}

function parseJsonLd (bodyText, options, emitter) {
  const { JsonLdParser } = require('jsonld-streaming-parser');
  var parser = new JsonLdParser({ baseIRI: options.baseIRI });
  // JSON-LD's @context is not exposed as prefix events by this parser.
  parser.on('data', function (quad) { emitter.emit('data', quad); });
  parser.on('error', function (error) { emitter.emit('error', error); });
  parser.on('end', function () { emitter.emit('end'); });
  parser.write(bodyText);
  parser.end();
}

function parseRdfXml (bodyText, options, emitter) {
  const { RdfXmlParser } = require('rdfxml-streaming-parser');
  var parser = new RdfXmlParser({ baseIRI: options.baseIRI });
  parser.on('data', function (quad) { emitter.emit('data', quad); });
  parser.on('error', function (error) { emitter.emit('error', error); });
  parser.on('end', function () { emitter.emit('end'); });
  parser.write(bodyText);
  parser.end();
}

// HTML can carry both RDFa and Microdata at once; run both extractors over
// independent copies of the same markup and merge their quads, matching
// what the previous Comunica-based HTML dispatch did.
function parseHtml (bodyText, options, emitter) {
  const { RdfaParser } = require('rdfa-streaming-parser');
  const { MicrodataRdfParser } = require('microdata-rdf-streaming-parser');
  var pending = 2;
  var errored = false;

  function done () {
    pending--;
    if (pending === 0 && !errored) emitter.emit('end');
  }
  function fail (error) {
    if (errored) return;
    errored = true;
    emitter.emit('error', error);
  }

  var rdfa = new RdfaParser({ baseIRI: options.baseIRI });
  rdfa.on('data', function (quad) { emitter.emit('data', quad); });
  rdfa.on('error', fail);
  rdfa.on('end', done);
  rdfa.write(bodyText);
  rdfa.end();

  var microdata = new MicrodataRdfParser({ baseIRI: options.baseIRI });
  microdata.on('data', function (quad) { emitter.emit('data', quad); });
  microdata.on('error', fail);
  microdata.on('end', done);
  microdata.write(bodyText);
  microdata.end();
}

function parseShaclCompact (bodyText, options, emitter) {
  const { parse } = require('shaclc-parse');
  // Synchronous API: emit asynchronously so callers can always treat this
  // as a stream, regardless of format.
  defer(function () {
    try {
      var quads = parse(bodyText, {
        baseIRI: options.baseIRI,
        extendedSyntax: options.contentType === 'text/shaclc-ext'
      });
      var prefixes = quads.prefixes || {};
      Object.keys(prefixes).forEach(function (prefix) {
        emitter.emit('prefix', prefix, prefixes[prefix]);
      });
      quads.forEach(function (quad) { emitter.emit('data', quad); });
      emitter.emit('end');
    } catch (error) {
      emitter.emit('error', error);
    }
  });
}

function parseJelly (bodyBuffer, options, emitter) {
  const { StreamParser } = require('rdfjs-jelly');
  var parser = new StreamParser();

  parser.on('namespace', function (prefix, iri) {
    emitter.emit('prefix', prefix, (iri && iri.value !== undefined) ? iri.value : iri);
  });
  // Jelly is inherently message-framed: every RdfStreamFrame is one message.
  parser.on('message', function (quads) { emitter.emit('message', quads); });

  // rdfjs-jelly's Node build is a classic Transform stream (write/end plus
  // 'data'/'error'/'end' events); its browser build -- which bundlers pick
  // up automatically via the package's "browser" export -- exposes Web
  // Streams (readable/writable) instead, with no 'data'/'error' events.
  if (typeof parser.write === 'function') {
    parser.on('data', function (quad) { emitter.emit('data', quad); });
    parser.on('error', function (error) { emitter.emit('error', error); });
    parser.on('end', function () { emitter.emit('end'); });
    parser.write(bodyBuffer);
    parser.end();
  } else {
    (async function () {
      try {
        var bytes = (bodyBuffer instanceof Uint8Array) ? bodyBuffer : new Uint8Array(bodyBuffer);
        // Feed the whole payload through a one-shot ReadableStream, piped
        // through the parser, and consume its output concurrently: writing
        // and reading must happen at the same time here, since the
        // transform doesn't buffer -- writing everything before reading
        // anything (e.g. via writer.write()/writer.close() first) deadlocks.
        var sourceStream = new ReadableStream({
          start: function (controller) {
            controller.enqueue(bytes);
            controller.close();
          }
        });
        var outputStream = parser.import(sourceStream);
        var reader = outputStream.getReader();
        for (;;) {
          var next = await reader.read();
          if (next.done) break;
          var item = next.value;
          emitter.emit('data', (item && item.quad) ? item.quad : item);
        }
        emitter.emit('end');
      } catch (error) {
        emitter.emit('error', error);
      }
    })();
  }
}

var TURTLE_FAMILY = ['text/turtle', 'application/trig', 'application/n-triples', 'application/n-quads', 'text/n3'];

/**
 * @param {object} options
 * @param {string} options.bodyText decoded (UTF-8) response body, for text formats
 * @param {Buffer} options.bodyBuffer raw response body, for binary formats (Jelly)
 * @param {string} options.contentType the response's content type
 * @param {string} options.baseIRI base IRI to resolve relative references against
 * @returns {EventEmitter}
 */
function parse (options) {
  var emitter = new EventEmitter();
  var contentType = baseContentType(options.contentType);

  defer(function () {
    try {
      if (TURTLE_FAMILY.indexOf(contentType) !== -1) {
        parseTurtleFamily(options.bodyText, options, emitter);
      } else if (contentType === 'application/ld+json' || contentType === 'application/json') {
        parseJsonLd(options.bodyText, options, emitter);
      } else if (contentType === 'application/rdf+xml') {
        parseRdfXml(options.bodyText, options, emitter);
      } else if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
        parseHtml(options.bodyText, options, emitter);
      } else if (contentType === 'text/shaclc' || contentType === 'text/shaclc-ext') {
        parseShaclCompact(options.bodyText, options, emitter);
      } else if (contentType === 'application/x-jelly-rdf') {
        parseJelly(options.bodyBuffer, options, emitter);
      } else {
        emitter.emit('error', new Error('Unsupported content type: ' + options.contentType));
      }
    } catch (error) {
      emitter.emit('error', error);
    }
  });

  return emitter;
}

module.exports = { parse };
