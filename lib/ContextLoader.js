/** A cached JSON-LD context loader that works on top of any fetch (browser, NodeJS, your own wrapper with
 *  retries/auth/stubs...). It plugs into jsonld-streaming-parser / jsonld-context-parser as `documentLoader`.
 *
 *    const { cachedDocumentLoader } = require('ldfetch/lib/ContextLoader.js');
 *    const HttpCache = require('ldfetch/lib/HttpCache.js');
 *    const documentLoader = cachedDocumentLoader({ fetch: myFetch, cache: new HttpCache({ minTTL: 600 }) });
 *    new JsonLdParser({ documentLoader });
 *
 *  Options:
 *   - fetch:     fetch(url, {headers}) resolving a Response (or anything with status, headers, text() and url).
 *                Defaults to globalThis.fetch.
 *   - cache:     an HttpCache (see HttpCache.js), or a falsy value to not cache. Following HTTP caching semantics:
 *                stale entries are revalidated with a conditional request and a 304 refreshes them.
 *   - getStatus: (response) => number. When your fetch hides the real status of a response (e.g. returns a 304 as a
 *                200 with a marker), tell the loader here. A hidden 304 keeps the stored content-type.
 *
 *  Only the context's own Accept header is sent: nothing else of the caller's request (credentials!) reaches a
 *  context's server. Concurrent loads of one URL share one request, a parsed context is returned as the very
 *  same object as long as its cache entry lives, and failures (404, 410, unparsable...) are never cached.
 *  This file is free of NodeJS-only modules so that it can be part of the browser bundle.
 */

var CONTEXT_ACCEPT = 'application/ld+json, application/json;q=0.9';
var MAX_ALTERNATES = 5;

// A minimal Link header parser: [{uri, rel: [...], type}]
function parseLinks(header) {
  var links = [];
  var linkRegex = /<([^>]*)>([^<]*)/g, match;
  while ((match = linkRegex.exec(header))) {
    var link = { uri: match[1], rel: [], type: undefined };
    var paramRegex = /;\s*([^=;\s,]+)\s*=\s*(?:"([^"]*)"|([^;,\s]*))/g, param;
    while ((param = paramRegex.exec(match[2]))) {
      var value = param[2] !== undefined ? param[2] : param[3];
      if (param[1].toLowerCase() === 'rel') link.rel = value.toLowerCase().split(/\s+/);
      else if (param[1].toLowerCase() === 'type') link.type = value.toLowerCase();
    }
    links.push(link);
  }
  return links;
}

function isJsonMediaType(contentType) {
  var mediaType = (contentType || '').split(';')[0].trim().toLowerCase();
  return mediaType === 'application/json' || mediaType.slice(-5) === '+json';
}

function alternateOf(response, url) {
  var header = response.headers && response.headers.link;
  if (!header) return undefined;
  var links = parseLinks(header).filter(function (link) {
    return link.rel.indexOf('alternate') !== -1 && link.type === 'application/ld+json';
  });
  if (links.length > 1) throw new Error('Multiple JSON-LD alternate links were found on ' + url);
  return links.length ? new URL(links[0].uri, response.url || url).href : undefined;
}

function plainHeaders(headers) {
  var result = {};
  if (headers && typeof headers.forEach === 'function') {
    headers.forEach(function (value, name) { result[name.toLowerCase()] = value; });
  }
  return result;
}

function cachedDocumentLoader(options) {
  options = options || {};
  var cache = options.cache || null;
  var fetchFn = options.fetch || function () { return globalThis.fetch.apply(globalThis, arguments); };
  var getStatus = options.getStatus;
  var inflight = new Map();
  // parsed contexts, per stored response: as long as the cache keeps an entry, the same object comes back
  var parsed = new WeakMap();
  var baseHeaders = { accept: CONTEXT_ACCEPT };

  // Reads what is in a (stored or fresh) response: {document} or {alternate} or throws
  function interpret(response, url) {
    if (parsed.has(response)) return { document: parsed.get(response) };
    if (isJsonMediaType(response.type)) {
      var document;
      try {
        document = JSON.parse(response.body);
      } catch (error) {
        throw new Error('Unable to parse the JSON-LD context at ' + url + ': ' + error.message);
      }
      return { document: document };
    }
    var alternate = alternateOf(response, url);
    if (alternate) return { alternate: alternate };
    throw new Error('Unsupported JSON-LD media type ' + response.type + ' for ' + url);
  }

  async function resolved(response, url, depth) {
    var result = interpret(response, url);
    if (result.alternate) return await doLoad(result.alternate, depth + 1);
    if (cache && !parsed.has(response)) parsed.set(response, result.document);
    return result.document;
  }

  async function doLoad(url, depth) {
    if (depth > MAX_ALTERNATES) throw new Error('Too many JSON-LD alternate links, ending at ' + url);
    var requestHeaders = baseHeaders;
    var stale;
    if (cache) {
      var found = await cache.lookup('GET', url, baseHeaders);
      if (found.state === 'fresh') return resolved(found.response, url, depth);
      if (found.state === 'stale') {
        stale = found.entry;
        requestHeaders = found.headers;
      }
    }

    var raw = await fetchFn(url, { headers: requestHeaders });
    var status = getStatus ? getStatus(raw) : raw.status;
    var headers = plainHeaders(raw.headers);

    if (status === 304 && stale) {
      // Not modified: refresh the entry. A hidden 304 is typically a 200 describing something else, so its
      // content-type must not overwrite the one of the stored response
      if (status !== raw.status) delete headers['content-type'];
      var revalidated = await cache.revalidated('GET', url, baseHeaders, stale, { statusCode: 304, headers: headers });
      if (parsed.has(stale.response)) parsed.set(revalidated, parsed.get(stale.response));
      return resolved(revalidated, url, depth);
    }
    if (!(status >= 200 && status < 300)) {
      throw new Error('Loading the JSON-LD context at ' + url + ' failed: ' + (raw.statusText || 'status code ' + status));
    }

    var response = {
      url: raw.url || url,
      type: (headers['content-type'] || '').split(';')[0].trim(),
      statusCode: status,
      headers: headers,
      body: await raw.text()
    };
    // Throws on anything that is not a usable context, before it can make it into the cache
    var document = await resolved(response, url, depth);
    if (cache) await cache.put('GET', url, baseHeaders, response);
    return document;
  }

  return {
    load: function (url) {
      var key = url.replace(/#.*/, '');
      if (inflight.has(key)) return inflight.get(key);
      var promise = doLoad(key, 0).finally(function () { inflight.delete(key); });
      inflight.set(key, promise);
      return promise;
    }
  };
}

module.exports = { cachedDocumentLoader: cachedDocumentLoader, CONTEXT_ACCEPT: CONTEXT_ACCEPT };
