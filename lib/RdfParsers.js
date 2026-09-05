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

// Some servers (static file hosts especially) serve RDF files with an
// unhelpful generic content type instead of the real media type. When that
// happens, guess from the URL's file extension instead -- the same fallback
// rdf-dereference uses, built as a small standalone table here rather than
// depending on rdf-parse (and its whole Comunica tree) just for this.
var UNHELPFUL_CONTENT_TYPES = ['text/plain', 'application/octet-stream'];

var EXTENSION_CONTENT_TYPES = {
  htm: 'text/html',
  html: 'text/html',
  json: 'application/ld+json',
  jsonld: 'application/ld+json',
  n3: 'text/n3',
  nq: 'application/n-quads',
  nquads: 'application/n-quads',
  nt: 'application/n-triples',
  ntriples: 'application/n-triples',
  owl: 'application/rdf+xml',
  rdf: 'application/rdf+xml',
  rdfxml: 'application/rdf+xml',
  shaclc: 'text/shaclc',
  shaclce: 'text/shaclc-ext',
  shc: 'text/shaclc',
  shce: 'text/shaclc-ext',
  trig: 'application/trig',
  ttl: 'text/turtle',
  turtle: 'text/turtle',
  xht: 'application/xhtml+xml',
  xhtml: 'application/xhtml+xml',
  xml: 'application/rdf+xml',
  jelly: 'application/x-jelly-rdf'
};

function guessContentTypeFromUrl (url) {
  var path = (url || '').split(/[?#]/)[0];
  var dotIndex = path.lastIndexOf('.');
  if (dotIndex === -1) return null;
  var extension = path.slice(dotIndex + 1).toLowerCase();
  return EXTENSION_CONTENT_TYPES[extension] || null;
}

// Resolves the content type to actually parse with: the declared one, unless
// it's one of the generic types above and the URL's extension suggests
// something more specific.
function resolveContentType (contentType, url) {
  var declared = baseContentType(contentType);
  if (UNHELPFUL_CONTENT_TYPES.indexOf(declared) === -1) return contentType;
  return guessContentTypeFromUrl(url) || contentType;
}

// The resource itself can be a compressed file (data.ttl.gz, data.jelly.zst,
// ...) -- independent of, and in addition to, HTTP Content-Encoding, which
// the fetchers already decompress transparently before we ever see the
// body. Detected from magic bytes rather than the URL or declared content
// type, so it's caught even if a server mislabels it.
function detectCompression (bodyBuffer) {
  if (!bodyBuffer || bodyBuffer.length < 4) return null;
  if (bodyBuffer[0] === 0x1f && bodyBuffer[1] === 0x8b) return 'gzip';
  if (bodyBuffer[0] === 0x28 && bodyBuffer[1] === 0xb5 && bodyBuffer[2] === 0x2f && bodyBuffer[3] === 0xfd) return 'zstd';
  return null;
}

function stripCompressionSuffix (url) {
  return (url || '').replace(/\.(?:gz|zst|zstd)$/i, '');
}

function decompressGzip (bytes) {
  if (typeof DecompressionStream !== 'undefined') {
    var stream = new Response(bytes).body.pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).arrayBuffer().then(function (buf) {
      return Buffer.from(buf);
    });
  }
  // Node has no DecompressionStream before v18's later releases in all
  // environments, but always has zlib. The require() argument is built
  // from a variable, not a string literal, so esbuild doesn't try (and
  // fail) to resolve this Node builtin when bundling for the browser --
  // this branch never runs there anyway, since DecompressionStream exists
  // in every browser we target.
  var nodeZlibModuleName = 'zlib';
  var zlib = require(nodeZlibModuleName);
  return Promise.resolve(zlib.gunzipSync(bytes));
}

function decompressZstd (bytes) {
  // Pure WebAssembly, works the same in Node and the browser bundle -- no
  // Node-version cliff the way rdfjs-jelly's own zlib-based zstd support has.
  const { Zstd } = require('@hpcc-js/wasm-zstd');
  return Zstd.load().then(function (zstd) {
    var input = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes);
    return Buffer.from(zstd.decompress(input));
  });
}

// Decompresses when needed, then resolves the content type to actually
// dispatch on: guessed from the (compression-suffix-stripped) URL when
// compressed, since the declared type almost always describes the
// compressed transfer rather than what's inside; otherwise the ordinary
// unhelpful-content-type fallback.
function prepareOptions (options) {
  var compression = detectCompression(options.bodyBuffer);
  if (!compression) {
    return Promise.resolve(Object.assign({}, options, {
      contentType: resolveContentType(options.contentType, options.baseIRI)
    }));
  }

  var decompress = compression === 'gzip' ? decompressGzip(options.bodyBuffer) : decompressZstd(options.bodyBuffer);
  return decompress.then(function (decompressedBuffer) {
    var innerUrl = stripCompressionSuffix(options.baseIRI);
    var innerContentType = guessContentTypeFromUrl(innerUrl) || options.contentType;
    return Object.assign({}, options, {
      bodyBuffer: decompressedBuffer,
      bodyText: decompressedBuffer.toString('utf8'),
      contentType: resolveContentType(innerContentType, innerUrl)
    });
  });
}

// Groups a parser's raw 'data' output into RDF Messages when the parser
// wraps items as `{ quad, messageCounter }` (rdf-parser-ts's convention).
// Plain (unwrapped) quads pass straight through without ever triggering a
// 'message' event, so ordinary, non-message documents behave exactly as
// before. Grouping is deferred to rdf-parser-ts's own toMessages() at 'end',
// rather than detected from messageCounter transitions as data arrives --
// an empty message produces no quads at all, so there's nothing in the
// 'data' stream to signal it started or ended; only toMessages(), given the
// complete item list, preserves those empty messages.
function relayMessageAwareStream (source, emitter) {
  const { isMessageQuad, toMessages } = require('rdf-parser-ts');
  var items = [];
  var sawMessageWrapping = false;

  source.on('prefix', function (prefix, iri) {
    emitter.emit('prefix', prefix, (iri && iri.value !== undefined) ? iri.value : iri);
  });
  source.on('data', function (item) {
    var quad = item;
    if (isMessageQuad(item)) {
      sawMessageWrapping = true;
      quad = item.quad;
    }
    items.push(item);
    emitter.emit('data', quad);
  });
  source.on('error', function (error) { emitter.emit('error', error); });
  source.on('end', function () {
    if (sawMessageWrapping) {
      toMessages(items).forEach(function (message) {
        emitter.emit('message', message);
      });
    }
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

  // Decompression (when needed) is async, so content-type resolution and
  // dispatch both happen once it (and the always-async prepareOptions
  // promise chain) settles -- this also supersedes the plain defer() this
  // used to use, since a promise chain is already at least one microtask.
  prepareOptions(options).then(function (resolved) {
    var contentType = baseContentType(resolved.contentType);
    try {
      if (TURTLE_FAMILY.indexOf(contentType) !== -1) {
        parseTurtleFamily(resolved.bodyText, resolved, emitter);
      } else if (contentType === 'application/ld+json' || contentType === 'application/json') {
        parseJsonLd(resolved.bodyText, resolved, emitter);
      } else if (contentType === 'application/rdf+xml') {
        parseRdfXml(resolved.bodyText, resolved, emitter);
      } else if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
        parseHtml(resolved.bodyText, resolved, emitter);
      } else if (contentType === 'text/shaclc' || contentType === 'text/shaclc-ext') {
        parseShaclCompact(resolved.bodyText, resolved, emitter);
      } else if (contentType === 'application/x-jelly-rdf') {
        parseJelly(resolved.bodyBuffer, resolved, emitter);
      } else {
        emitter.emit('error', new Error('Unsupported content type: ' + resolved.contentType));
      }
    } catch (error) {
      emitter.emit('error', error);
    }
  }).catch(function (error) {
    emitter.emit('error', error);
  });

  return emitter;
}

module.exports = { parse };
