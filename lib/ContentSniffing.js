// Pure helpers for working out what a resource is, from its names and its
// first bytes. No Node.js APIs, so that the Node.js library (RdfParsers.js)
// and the browser playground share them. Bytes are Uint8Arrays (or Buffers).

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

// The file name that a gzip header carries (FNAME), '' when it has none, or
// null when more bytes are needed to tell
function gzipFileName (head) {
  if (head.length < 10) return null;
  var flags = head[3];
  var offset = 10;
  if (flags & 4) {
    if (head.length < offset + 2) return null;
    offset += 2 + head[offset] + head[offset + 1] * 256;
  }
  if (!(flags & 8)) return '';
  var end = offset;
  while (end < head.length && head[end] !== 0) end++;
  if (end >= head.length) return null;
  var name = '';
  for (var i = offset; i < end; i++) name += String.fromCharCode(head[i]);
  return name;
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
  var text = new TextDecoder('utf-8').decode(head).replace(/^\uFEFF/, '').trimStart();
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


module.exports = {
  baseContentType, guessContentTypeFromUrl, detectCompression, stripCompressionSuffix, gzipFileName,
  contentDispositionFileName, sniffContentType, isUnhelpful, typeFromNames, UNHELPFUL_CONTENT_TYPES
};
