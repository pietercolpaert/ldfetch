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
  // RML mapping files are conventionally Turtle, but often just named .rml
  rml: 'text/turtle',
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
// A few servers still use legacy, non-standard media types for formats that
// have a standard one today -- e.g. HAPI FHIR's own `?_format=ttl` query
// param returns `application/x-turtle` instead of `text/turtle`. Normalized
// up front so the rest of the pipeline (format dispatch, and the format
// hint handed to n3.js-messages) only ever has to deal with the standard name.
var LEGACY_CONTENT_TYPE_ALIASES = {
  'application/x-turtle': 'text/turtle',
  // CSV on the Web metadata is JSON-LD, with the CSVW context
  'application/csvm+json': 'application/ld+json'
};

// `url` is where the extension is normally guessed from (the response's
// final URL, after redirects). `fallbackUrl`, when given, is tried second --
// it exists because a redirect to an opaque storage location (a GitHub
// release asset, a signed S3/Azure Blob URL, ...) commonly drops the
// extension the original request URL carried, e.g. ".../jelly_10K.jelly.gz"
// resolving to ".../e34d9512-...?sig=...". The originally requested URL is
// passed here as that fallback so the extension hint survives the redirect.
function resolveContentType (contentType, url, fallbackUrl) {
  var declared = baseContentType(contentType);
  if (LEGACY_CONTENT_TYPE_ALIASES[declared]) return LEGACY_CONTENT_TYPE_ALIASES[declared];
  if (UNHELPFUL_CONTENT_TYPES.indexOf(declared) === -1) return contentType;
  return guessContentTypeFromUrl(url) || guessContentTypeFromUrl(fallbackUrl) || contentType;
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
      contentType: resolveContentType(options.contentType, options.baseIRI, options.requestUrl)
    }));
  }

  var decompress = compression === 'gzip' ? decompressGzip(options.bodyBuffer) : decompressZstd(options.bodyBuffer);
  return decompress.then(function (decompressedBuffer) {
    var innerUrl = stripCompressionSuffix(options.baseIRI);
    var innerFallbackUrl = stripCompressionSuffix(options.requestUrl);
    var innerContentType = guessContentTypeFromUrl(innerUrl) || guessContentTypeFromUrl(innerFallbackUrl) || options.contentType;
    return Object.assign({}, options, {
      bodyBuffer: decompressedBuffer,
      bodyText: decompressedBuffer.toString('utf8'),
      contentType: resolveContentType(innerContentType, innerUrl, innerFallbackUrl)
    });
  });
}

// Parses the Turtle family with n3.js-messages, which wraps N3.js and adds
// RDF Message support (Turtle/TriG/N-Triples/N-Quads "-messages" versions).
// Normalizes its callbacks to the emitter contract:
//   'prefix', 'data' (quad, messageCounter), 'message' (quad[]), 'error', 'end'
//
// Quads are relayed as they are parsed, not once their message completes, so
// a multi-GB message log streams out progressively (see issue #59). Each
// 'data' emission is tagged with the index of the message it belongs to --
// undefined for a document that does not announce a "-messages" version, so
// ordinary documents behave exactly as before and never trigger a 'message'
// event. A consumer can write RDF Message Log-shaped output from these tags
// (see messageCounter in the README); empty messages, including trailing
// ones, are reported through 'message' by n3.js-messages itself.
//
// text/n3 is not an RDF Messages syntax, so it is parsed with plain N3.js.
function relayTurtleFamily (input, options, emitter) {
  var type = baseContentType(options.contentType);
  if (type === 'text/n3') {
    const { StreamParser } = require('n3');
    var n3Parser = new StreamParser({ baseIRI: options.baseIRI, format: 'text/n3' });
    n3Parser.on('prefix', function (prefix, iri) { emitter.emit('prefix', prefix, iri.value); });
    n3Parser.on('data', function (quad) { emitter.emit('data', quad); });
    n3Parser.on('error', function (error) { emitter.emit('error', error); });
    n3Parser.on('end', function () { emitter.emit('end'); });
    if (typeof input === 'string') {
      n3Parser.write(input);
      n3Parser.end();
    } else {
      input.on('error', function (error) { emitter.emit('error', error); });
      input.pipe(n3Parser);
    }
    return;
  }

  const { MessageParser } = require('n3.js-messages');
  var messageLog = false;
  var failed = false;
  function fail (error) {
    if (failed) return;
    failed = true;
    emitter.emit('error', error);
  }
  if (typeof input !== 'string') input.on('error', fail);
  new MessageParser({ baseIRI: options.baseIRI, format: type }).parse(input, {
    onVersion: function (label) { messageLog = /-messages$/.test(label); },
    onPrefix: function (prefix, iri) { emitter.emit('prefix', prefix, iri.value); },
    onQuad: function (error, quad, messageIndex) {
      if (error) return fail(error);
      if (!failed) emitter.emit('data', quad, messageLog ? messageIndex : undefined);
    },
    onMessage: function (error, message) {
      if (error) return fail(error);
      if (failed) return;
      if (message === null) emitter.emit('end');
      else if (messageLog) emitter.emit('message', message);
    }
  });
}

function parseTurtleFamily (bodyText, options, emitter) {
  relayTurtleFamily(bodyText, options, emitter);
}

// jsonld-context-parser's default document loader (used to fetch a remote
// @context, e.g. "https://schema.org") falls back to a bare `fetch`
// identifier lookup when no fetcher is given it. That lookup has turned out
// to be unreliable in practice -- observed throwing "(this.fetcher ||
// fetch) is not a function" even though globalThis.fetch is genuinely a
// function at the time, seemingly whenever the surrounding call chain goes
// through a couple of extra EventEmitter hops (e.g. ldfetch's own
// 'downloaded' event being re-emitted) before reaching it. Passing
// globalThis.fetch explicitly here sidesteps whatever that lookup is
// sensitive to, and works identically in the browser (a native global too).
// A remote @context is just as much a "browser HTTP request" as the main
// document, so it needs the same mixed-content workaround (see
// BrowserHttpFetcher.js's upgradeIfMixedContent): browsers block http://
// fetches from an https:// page outright, and a lot of real-world JSON-LD
// (e.g. IIIF manifests) still declares its context via the historical
// http:// form even though the same document is also served over https.
// Only upgrades when actually running in a browser on an https page --
// this module is shared with the Node CLI/library, where http:// contexts
// are never blocked and should be left alone.
function fetchForJsonLdContext (proxy) {
  return function (url, init) {
    // A proxy is an HTTPS transport envelope around the original context
    // URL, so keep that URL untouched (including an http: scheme) and apply
    // the same direct concatenation used for the top-level browser request.
    if (proxy) return globalThis.fetch(proxy + url, init);
    // In a browser, try an http: context over https: first: an https: page
    // may not load it at all, and a server redirecting http: to https:
    // without CORS headers on the redirect (www.w3.org, for the CSVW
    // context among others) fails on any page. Fall back to the http: URL.
    if (typeof window !== 'undefined' && /^http:\/\//i.test(url)) {
      var secure = url.replace(/^http:/i, 'https:');
      var insecurePage = !(window.location && window.location.protocol === 'https:');
      return globalThis.fetch(secure, init).catch(function (error) {
        if (!insecurePage) throw error;
        return globalThis.fetch(url, init);
      });
    }
    return globalThis.fetch(url, init);
  };
}

function jsonLdDocumentLoader (options) {
  const { FetchDocumentLoader } = require('jsonld-context-parser');
  return new FetchDocumentLoader(fetchForJsonLdContext(options && options.proxy));
}

function parseJsonLd (bodyText, options, emitter) {
  const { JsonLdParser } = require('jsonld-streaming-parser');
  var parser = new JsonLdParser({ baseIRI: options.baseIRI, documentLoader: jsonLdDocumentLoader(options) });
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

// A page can embed RDF via <script type="application/ld+json"> blocks in
// addition to (or instead of) RDFa/Microdata attributes -- this is a plain
// regex extraction rather than a full HTML tokenizer, so it can in theory
// misfire on a JSON-LD value that itself contains the literal text
// "</script>", but that's the same practical trade-off most lightweight
// JSON-LD-in-HTML extractors make.
function extractJsonLdScripts (html) {
  var blocks = [];
  var scriptTag = /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;
  var match;
  while ((match = scriptTag.exec(html)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

// HTML can carry RDFa, Microdata, and embedded JSON-LD <script> blocks all
// at once; run all extractors that apply over independent copies of the
// same markup and merge their quads, matching what the previous
// Comunica-based HTML dispatch did.
function parseHtml (bodyText, options, emitter) {
  const { RdfaParser } = require('rdfa-streaming-parser');
  const { MicrodataRdfParser } = require('microdata-rdf-streaming-parser');
  const { JsonLdParser } = require('jsonld-streaming-parser');
  var jsonLdBlocks = extractJsonLdScripts(bodyText);
  var pending = 2 + jsonLdBlocks.length;
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

  // A script block with a remote @context (e.g. "https://schema.org") needs
  // jsonld-context-parser to fetch that context over the network -- see
  // jsonLdDocumentLoader() for why that's given an explicit fetch rather
  // than left to its own fallback lookup. One retry (a fresh parser
  // instance -- the first one is already in a failed state) is kept as a
  // safety net for a genuine transient network hiccup fetching the remote
  // context; a still-malformed block (or a genuinely unreachable context)
  // shouldn't take down RDFa/Microdata extraction, or any other JSON-LD
  // block, from the same page, so it's skipped after that.
  function runJsonLdBlock (jsonText, retriesLeft) {
    var jsonLd = new JsonLdParser({ baseIRI: options.baseIRI, documentLoader: jsonLdDocumentLoader(options) });
    jsonLd.on('data', function (quad) { emitter.emit('data', quad); });
    jsonLd.on('error', function () {
      if (retriesLeft > 0) {
        runJsonLdBlock(jsonText, retriesLeft - 1);
      } else {
        done();
      }
    });
    jsonLd.on('end', done);
    jsonLd.write(jsonText);
    jsonLd.end();
  }
  jsonLdBlocks.forEach(function (jsonText) { runJsonLdBlock(jsonText, 1); });
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

// Wires a Jelly parser's 'namespace'/'message' events to the normalized
// 'prefix'/'message' contract, and returns a function that emits 'data'
// tagged with the current messageCounter -- Jelly is inherently
// message-framed (every RdfStreamFrame is one message) and its 'message'
// event fires (bumping the counter) before the quads it contains reach
// 'data', so a locally incremented counter is all that's needed to give
// Jelly the same per-quad messageCounter tag relayTurtleFamily gives
// Turtle-family sources -- letting a consumer write RDF Message Log-shaped
// output the same way regardless of which family the source belongs to.
function wireJellyMessages (parser, emitter) {
  var messageCounter = -1;
  var sawMessage = false;
  parser.on('namespace', function (prefix, iri) {
    emitter.emit('prefix', prefix, (iri && iri.value !== undefined) ? iri.value : iri);
  });
  parser.on('message', function (quads) {
    sawMessage = true;
    messageCounter++;
    emitter.emit('message', quads);
  });
  return function (quad) {
    emitter.emit('data', quad, sawMessage ? messageCounter : undefined);
  };
}

function parseJelly (bodyBuffer, options, emitter) {
  const { StreamParser } = require('rdfjs-jelly');
  var parser = new StreamParser();
  var tagData = wireJellyMessages(parser, emitter);

  // rdfjs-jelly's Node build is a classic Transform stream (write/end plus
  // 'data'/'error'/'end' events); its browser build -- which bundlers pick
  // up automatically via the package's "browser" export -- exposes Web
  // Streams (readable/writable) instead, with no 'data'/'error' events.
  if (typeof parser.write === 'function') {
    parser.on('data', tagData);
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
          tagData((item && item.quad) ? item.quad : item);
        }
        emitter.emit('end');
      } catch (error) {
        emitter.emit('error', error);
      }
    })();
  }
}

// ---------------------------------------------------------------------
// Streaming a compressed or mislabelled resource (see issue #59)
//
// parse() sniffs compression and the content type from the whole buffered
// body, which a multi-GB .nt.gz message log must never become. prepareStream()
// does the same from just the first bytes of a live stream: it
//   1. peeks at the head of the stream, and recognizes gzip (and zstd, where
//      this Node.js has a streaming decompressor) by its magic bytes;
//   2. decompresses on the fly, through a pipe, so backpressure still works;
//   3. works out the type of what is inside, from the first source that says
//      something specific: the declared content type, the file name in the
//      gzip header (FNAME), a Content-Disposition file name, the URL's
//      extension (before and after redirects), and finally the first bytes
//      of the decompressed text itself.
// Resolves to { stream, contentType, decompressed }. For zstd without a
// streaming decompressor, the stream stays compressed (decompressed is
// false): the caller then buffers the body and uses parse(), as before.

// Resolves with whatever is available once `isEnough(buffer)` holds, or at
// the end of the stream. The stream is only read as far as needed; the
// returned stream replays what was read, then continues with the rest.
function peekStream (stream, isEnough) {
  const { PassThrough } = require('stream');
  return new Promise(function (resolve, reject) {
    var head = Buffer.alloc(0);
    var ended = false;
    function finish () {
      stream.removeListener('readable', onReadable);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      var replay = new PassThrough();
      stream.on('error', function (error) { replay.destroy(error); });
      replay.write(head);
      if (ended) replay.end();
      else stream.pipe(replay);
      resolve({ head: head, stream: replay });
    }
    function onReadable () {
      var chunk;
      while ((chunk = stream.read()) !== null) {
        head = Buffer.concat([head, chunk]);
        if (isEnough(head)) return finish();
      }
    }
    function onEnd () { ended = true; finish(); }
    function onError (error) { reject(error); }
    stream.on('readable', onReadable);
    stream.on('end', onEnd);
    stream.on('error', onError);
    onReadable();
  });
}

// The file name that a gzip header carries (FNAME), '' when it has none, or
// null when more bytes are needed to tell
function gzipFileName (head) {
  if (head.length < 10) return null;
  var flags = head[3];
  var offset = 10;
  if (flags & 4) {
    if (head.length < offset + 2) return null;
    offset += 2 + head.readUInt16LE(offset);
  }
  if (!(flags & 8)) return '';
  var end = head.indexOf(0, offset);
  if (end === -1 || offset > head.length) return null;
  return head.toString('latin1', offset, end);
}

function contentDispositionFileName (header) {
  var match = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(header || '') || /filename\s*=\s*"?([^";]+)"?/i.exec(header || '');
  if (!match) return null;
  try { return decodeURIComponent(match[1].trim()); } catch (error) { return match[1].trim(); }
}

// A last resort for a resource without any usable name: what its first
// bytes look like. Turtle, N-Triples and TriG (message logs included) are
// all read by the TriG parser.
function sniffContentType (head) {
  var text = head.toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (/^[{[]/.test(text)) return 'application/ld+json';
  if (/^<\?xml|^<rdf:RDF/i.test(text)) return 'application/rdf+xml';
  if (/^<!doctype html|^<html/i.test(text)) return 'text/html';
  if (/^(?:@?(?:prefix|base|version)\b|<|_:|#|message\b)/i.test(text)) return 'application/trig';
  return null;
}

function isUnhelpful (contentType) {
  var type = baseContentType(contentType);
  return !type || UNHELPFUL_CONTENT_TYPES.indexOf(type) !== -1 || type === 'application/gzip' || type === 'application/x-gzip' ||
    type === 'application/zstd' || type === 'application/x-zstd';
}

function typeFromNames (names) {
  for (var name of names) {
    var type = guessContentTypeFromUrl(stripCompressionSuffix(name));
    if (type) return type;
  }
  return null;
}

/**
 * @param {stream.Readable} nodeStream the response body, already decoded from
 *   any HTTP Content-Encoding
 * @param {object} options
 * @param {string} options.contentType the declared content type
 * @param {string} options.url the final URL
 * @param {string} [options.requestUrl] the requested URL, before redirects
 * @param {string} [options.contentDisposition] the Content-Disposition header
 * @returns {Promise<{stream: stream.Readable, contentType: string, decompressed: boolean}>}
 *   the stream to read from (the original bytes again when decompressed is
 *   false, which also is the case for zstd without a streaming decompressor)
 */
function prepareStream (nodeStream, options) {
  var declared = options.contentType;
  var names = [contentDispositionFileName(options.contentDisposition), options.url, options.requestUrl].filter(Boolean);

  return peekStream(nodeStream, function (head) {
    return head.length >= 4 && (head[0] !== 0x1f || head[1] !== 0x8b || gzipFileName(head) !== null || head.length >= 4096);
  }).then(function (peeked) {
    var compression = detectCompression(peeked.head);
    var stream = peeked.stream;
    var decompressed = false;
    if (compression) {
      var zlibModuleName = 'zlib';
      var zlib = require(zlibModuleName);
      if (compression === 'gzip') {
        names.unshift(gzipFileName(peeked.head) || '');
        var gunzip = zlib.createGunzip();
        stream.on('error', function (error) { gunzip.destroy(error); });
        stream = stream.pipe(gunzip);
        decompressed = true;
      } else if (typeof zlib.createZstdDecompress === 'function') {
        var unzstd = zlib.createZstdDecompress();
        stream.on('error', function (error) { unzstd.destroy(error); });
        stream = stream.pipe(unzstd);
        decompressed = true;
      } else {
        return { stream: stream, contentType: options.contentType, decompressed: false };
      }
      // What the declared type says is about the compressed transfer
      declared = null;
    }
    var type = isUnhelpful(declared) ? typeFromNames(names) : declared;
    if (type) return { stream: stream, contentType: type, decompressed: decompressed };
    // No name says anything specific: look at the text itself
    return peekStream(stream, function (head) { return head.length >= 512; }).then(function (inner) {
      return { stream: inner.stream, contentType: sniffContentType(inner.head) || options.contentType, decompressed: decompressed };
    });
  });
}

var TURTLE_FAMILY = ['text/turtle', 'application/trig', 'application/n-triples', 'application/n-quads', 'text/n3'];

// Only these have a genuine incremental parser that can consume a live
// stream instead of a fully buffered body -- checked by callers (via
// isStreamable()) before choosing parseStream() over parse().
function isStreamable (contentType) {
  var type = baseContentType(contentType);
  return TURTLE_FAMILY.indexOf(type) !== -1 || type === 'application/x-jelly-rdf';
}

function parseTurtleFamilyStream (nodeStream, options, emitter) {
  relayTurtleFamily(nodeStream, options, emitter);
}

function parseJellyStream (nodeStream, options, emitter) {
  const { StreamParser } = require('rdfjs-jelly');
  var parser = new StreamParser();
  var tagData = wireJellyMessages(parser, emitter);

  parser.on('data', tagData);
  parser.on('error', function (error) { emitter.emit('error', error); });
  parser.on('end', function () { emitter.emit('end'); });
  nodeStream.on('error', function (error) { emitter.emit('error', error); });
  nodeStream.pipe(parser);
}

/**
 * Like parse(), but consumes a live Node stream instead of an already
 * buffered body -- for sources too large to hold in memory entirely (see
 * issue #59). Only content types isStreamable() accepts (Turtle-family and
 * Jelly-RDF) have a genuine incremental parser; there is no byte-sniffing
 * here (compression magic bytes, unhelpful-content-type extension guessing)
 * since both need the body up front, which streaming mode never has --
 * callers resolve options.contentType via resolveContentType() themselves,
 * and fall back to parse() with a buffered body for anything else.
 *
 * @param {stream.Readable} nodeStream the (already decompressed at the
 *   transfer-encoding level) response body
 * @param {object} options
 * @param {string} options.contentType the resolved content type to parse as
 * @param {string} options.baseIRI base IRI to resolve relative references against
 * @returns {EventEmitter}
 */
function parseStream (nodeStream, options) {
  var emitter = new EventEmitter();
  defer(function () {
    var contentType = baseContentType(options.contentType);
    try {
      if (TURTLE_FAMILY.indexOf(contentType) !== -1) {
        parseTurtleFamilyStream(nodeStream, options, emitter);
      } else if (contentType === 'application/x-jelly-rdf') {
        parseJellyStream(nodeStream, options, emitter);
      } else {
        emitter.emit('error', new Error('Streaming is not supported for content type: ' + options.contentType));
      }
    } catch (error) {
      emitter.emit('error', error);
    }
  });
  return emitter;
}

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

module.exports = { parse, parseStream, prepareStream, isStreamable, resolveContentType };
