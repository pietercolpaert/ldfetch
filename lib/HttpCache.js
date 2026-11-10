/** An HTTP cache for the NodeJS HttpFetcher that follows HTTP caching semantics (RFC 9111)
 *  through http-cache-semantics: Cache-Control, Expires, Age, Vary, heuristic freshness,
 *  and revalidation with If-None-Match/If-Modified-Since.
 *
 *  Options:
 *   - store:      where entries are kept. Anything with get(key), set(key, value) and delete(key)
 *                 (sync or async) works, e.g. a Map, a Keyv instance or your own disk-backed store.
 *                 Defaults to an in-memory LRU of `maxEntries` entries.
 *   - minTTL:     the minimum time (in seconds) a stored response is served without asking the server,
 *                 even when its own headers say it is already stale (max-age=0, no-cache, no freshness
 *                 information at all, ...). Defaults to 0: strictly follow the server's headers.
 *                 `Cache-Control: no-store` is still honoured unless `overrideNoStore` is set.
 *   - maxTTL:     the maximum time (in seconds) a stored response is served without revalidating it,
 *                 even when its own headers say it stays fresh for longer. Defaults to unlimited.
 *                 Together with minTTL, the effective lifetime is clamp(serverLifetime, minTTL, maxTTL).
 *   - overrideNoStore: explicit opt-in to also store `Cache-Control: no-store` responses (200 only), to be
 *                 served for `minTTL` seconds. Without a minTTL it has no effect.
 *   - maxEntries: size of the default in-memory store (default 500)
 */

var CachePolicy = require('http-cache-semantics');

// Map-based LRU: Map iterates in insertion order, so the first key is the least recently used
function MemoryStore(maxEntries) {
  this._map = new Map();
  this._max = maxEntries;
}
MemoryStore.prototype.get = function (key) {
  if (!this._map.has(key)) return undefined;
  var value = this._map.get(key);
  this._map.delete(key);
  this._map.set(key, value);
  return value;
};
MemoryStore.prototype.set = function (key, value) {
  this._map.delete(key);
  this._map.set(key, value);
  if (this._map.size > this._max) {
    this._map.delete(this._map.keys().next().value);
  }
};
MemoryStore.prototype.delete = function (key) {
  this._map.delete(key);
};
Object.defineProperty(MemoryStore.prototype, 'size', {
  get: function () { return this._map.size; }
});

function HttpCache(options) {
  options = options || {};
  if (options.minTTL !== undefined && !(options.minTTL >= 0)) {
    throw new Error('minTTL must be a non-negative number of seconds');
  }
  this.store = options.store || new MemoryStore(options.maxEntries || 500);
  if (options.maxTTL !== undefined && !(options.maxTTL >= 0)) {
    throw new Error('maxTTL must be a non-negative number of seconds');
  }
  this.minTTL = (options.minTTL || 0) * 1000;
  this.maxTTL = options.maxTTL === undefined ? Infinity : options.maxTTL * 1000;
  if (this.minTTL > this.maxTTL) {
    throw new Error('minTTL cannot be larger than maxTTL');
  }
  this.overrideNoStore = !!options.overrideNoStore;
  this._stats = { hits: 0, misses: 0, revalidations: 0, stores: 0 };
}

function cacheKey(method, url) {
  return method + ' ' + url.replace(/#.*/, '');
}

function policyRequest(method, url, headers) {
  return { url: url.replace(/#.*/, ''), method: method, headers: headers || {} };
}

// Stores may have serialized the entry (e.g. to JSON), in which case Buffers come back as {type:'Buffer',data:[]}
function reviveResponse(response) {
  if (response.bodyBuffer && typeof Buffer !== 'undefined' && !Buffer.isBuffer(response.bodyBuffer)) {
    response.bodyBuffer = Buffer.from(response.bodyBuffer);
  }
  return response;
}

// Vary has to keep matching when we serve something without asking the server, also when minTTL stretches freshness
function varyMatches(entry, requestHeaders) {
  var vary = entry.response.headers && entry.response.headers.vary;
  if (!vary) return true;
  var storedHeaders = entry.requestHeaders || {};
  return vary.split(',').every(function (name) {
    name = name.trim().toLowerCase();
    if (name === '*') return false;
    return (storedHeaders[name] || '') === (requestHeaders[name] || '');
  });
}

/** Resolves to {state: 'miss'} | {state: 'fresh', response} | {state: 'stale', headers, entry}
 *  where `headers` are the request headers extended with the validators for a conditional request.
 *  `headers` must be lower-cased header names. */
HttpCache.prototype.lookup = async function (method, url, headers) {
  var raw;
  try {
    raw = await this.store.get(cacheKey(method, url));
  } catch (error) {
    raw = undefined;
  }
  if (!raw) {
    this._stats.misses++;
    return { state: 'miss' };
  }
  var entry = {
    policy: CachePolicy.fromObject(raw.policy),
    response: reviveResponse(raw.response),
    requestHeaders: raw.requestHeaders,
    storedAt: raw.storedAt
  };
  var request = policyRequest(method, url, headers);
  var age = Date.now() - entry.storedAt;
  var fresh = entry.policy.satisfiesWithoutRevalidation(request) && age < this.maxTTL;
  if (!fresh && this.minTTL > 0 && age < this.minTTL) {
    fresh = varyMatches(entry, headers);
  }
  if (fresh) {
    this._stats.hits++;
    return { state: 'fresh', response: entry.response };
  }
  this._stats.misses++;
  return { state: 'stale', headers: entry.policy.revalidationHeaders(request), entry: entry };
};

/** Stores a response if its headers allow it. `response` is the object NodeHttpFetcher resolves with. */
HttpCache.prototype.put = async function (method, url, requestHeaders, response) {
  var policy = new CachePolicy(
    policyRequest(method, url, requestHeaders),
    { status: response.statusCode, headers: response.headers || {} },
    { shared: false }
  );
  if (!policy.storable()) {
    var noStore = /(^|[\s,])no-store/i.test((response.headers || {})['cache-control'] || '');
    if (!(this.overrideNoStore && this.minTTL > 0 && noStore && response.statusCode === 200)) return false;
  }
  await this._write(method, url, policy, requestHeaders, response);
  return true;
};

/** Handles a 304 to a conditional request: refreshes the stored entry and returns the response to hand out. */
HttpCache.prototype.revalidated = async function (method, url, requestHeaders, entry, notModified) {
  this._stats.revalidations++;
  var result = entry.policy.revalidatedPolicy(
    policyRequest(method, url, requestHeaders),
    { status: notModified.statusCode, headers: notModified.headers || {} }
  );
  var response = Object.assign({}, entry.response, { headers: result.policy.responseHeaders() });
  await this._write(method, url, result.policy, requestHeaders, response);
  return response;
};

HttpCache.prototype._write = async function (method, url, policy, requestHeaders, response) {
  try {
    await this.store.set(cacheKey(method, url), {
      policy: policy.toObject(),
      response: response,
      requestHeaders: requestHeaders,
      storedAt: Date.now()
    });
    this._stats.stores++;
  } catch (error) {
    console.error('Warning: unable to set key in cache ' + url);
  }
};

HttpCache.prototype.getStats = function () {
  var stats = Object.assign({}, this._stats);
  if (typeof this.store.size === 'number') stats.keys = this.store.size;
  return stats;
};

HttpCache.MemoryStore = MemoryStore;
module.exports = HttpCache;
