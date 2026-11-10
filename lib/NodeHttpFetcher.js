/*! @license ©2013 Ruben Verborgh, 2016 Pieter Colpaert - Data Science Lab / iMinds / Ghent University, 2017 Pieter Colpaert - IDLab / imec / Ghent University */
/** A HttpFetcher downloads documents through HTTP. The NodeHttpFetcher implements this for nodejs useage (for the browser, check out BrowserHttpFetcher.js) */

var q = require('q'),
  http = require('follow-redirects/http'),
  https = require('follow-redirects/https'),
  util = require('util'),
  zlib = require('zlib'),
  fs = require('fs'),
  fileURLToPath = require('url').fileURLToPath,
  HttpCache = require('./HttpCache.js'),
  EventEmitter = require('events');

var USER_AGENT = 'Linked Data Fetch for NodeJS';

// Turns the `cache` option into an HttpCache (or null when caching is disabled):
// false disables, true/undefined gives an in-memory cache, an object configures a new HttpCache
// ({store, minTTL, maxEntries}), and an HttpCache instance is used as is (so it can be shared)
function resolveCache(option) {
  if (option === false || option === null) return null;
  if (option instanceof HttpCache) return option;
  if (option && typeof option === 'object') {
    if (typeof option.lookup === 'function' && typeof option.put === 'function') return option;
    return new HttpCache(option);
  }
  return new HttpCache();
}

// Creates a new HttpFetcher
function HttpFetcher(accept, maxParallel, enableCache, customHeaders) {
  EventEmitter.call(this);
  this._accept = accept || 'application/ld+json;q=1.0';
  this._cache = resolveCache(true);
  this._queue = [];    // Queue of request execution functions
  this._active = {};   // Hash of active requests
  this._pending = 0;   // The number of currently active requests
  this._maxParallel = 5; // Only execute this many requests in parallel
  this._customHeaders = {}; // Additional HTTP headers for Connection fetching requests
  this.localFiles = false; // file:// URLs are opt-in (disabled by default for security)
  
  // Check for params types one by one to allow backwards compatibility
  if (typeof maxParallel !== 'undefined') {
    if (typeof maxParallel !== 'number') {
      if(typeof maxParallel !== 'boolean') {
        this._customHeaders = maxParallel;
      } else {
        this._cache = resolveCache(maxParallel);
      }
    } else {
      this._maxParallel = maxParallel;
    }
  }

  if(typeof enableCache !== 'undefined') {
    if(typeof enableCache !== 'boolean') {
      this._customHeaders = enableCache;
    } else {
      this._cache = resolveCache(enableCache);
    }
  }

  if(typeof customHeaders !== 'undefined') {
    this._customHeaders = customHeaders;
  }
}

util.inherits(HttpFetcher, EventEmitter);

// Configures the HTTP cache of this fetcher: false disables it, true gives an in-memory one,
// an object ({store, minTTL, maxEntries}) configures it, an HttpCache instance is used as is.
HttpFetcher.prototype.setCache = function (option) {
  this._cache = resolveCache(option);
};

// Configures the cache used for JSON-LD contexts (see getContextCache). Defaults to the document cache.
HttpFetcher.prototype.setContextCache = function (option) {
  this._contextCache = option === undefined ? undefined : resolveCache(option);
};

// Header names are lower-cased so that they can be handed to the cache as they are
HttpFetcher.prototype._buildHeaders = function (accept, customHeaders) {
  var headers = {
    'accept': accept,
    'user-agent': USER_AGENT,
    'accept-encoding': 'gzip, deflate'
  };
  for (let [k, v] of Object.entries(customHeaders)) {
    headers[k.toLowerCase()] = v;
  }
  return headers;
};

// Returns a promise for the HTTP GET request's result
HttpFetcher.prototype.get = function (url) {
  return this.request(url, 'GET');
};

// The cache for JSON-LD contexts: its own when configured with setContextCache, else the document cache
HttpFetcher.prototype.getContextCache = function () {
  return this._contextCache === undefined ? this._cache : this._contextCache;
};

// A fetch-like function (fetch(url, {headers}) => Response-like) for the cached JSON-LD context loader
// (ContextLoader.js). It never caches by itself (the loader does, and needs to see 304s), and it only sends
// the headers it is given: the custom headers (e.g. credentials meant for the document's server) are not
// carried over to the, possibly third-party, context host.
HttpFetcher.prototype.contextFetch = function (url, init) {
  var headers = (init && init.headers) || {};
  return this.request(url, 'GET', { accept: headers.accept, customHeaders: headers, cache: null }).then(function (response) {
    return {
      status: response.statusCode,
      url: response.url,
      headers: new Headers(Object.entries(response.headers || {}).map(function (entry) {
        return [entry[0], Array.isArray(entry[1]) ? entry[1].join(', ') : entry[1]];
      })),
      text: function () { return Promise.resolve(response.body); }
    };
  });
};

// Returns a promise for the HTTP request's result
// options (all optional): accept, customHeaders, cache (an HttpCache or null) override the fetcher's own
HttpFetcher.prototype.request = function (url, methodName, options) {
  options = options || {};
  this.emit('request', url);
  var method = methodName || 'GET';
  var accept = options.accept || this._accept;
  var customHeaders = options.customHeaders || this._customHeaders;
  var cache = options.cache === undefined ? this._cache : options.cache;
  var requestId = method + (options.accept ? ' ' + options.accept : '') + url;
  var baseHeaders = this._buildHeaders(accept, customHeaders);
  var cached; // the stale cache entry we are revalidating, if any
  var conditionalHeaders;

  // First check whether the request was already pending
  if (requestId in this._active)
    return this._active[requestId].result;
  // If not, prepare to make a request
  var self = this, deferred = q.defer();

  // Request execution function
  function execute() {
    // Check whether the request is pending in the meantime
    if (requestId in self._active)
      return deferred.resolve(self._active[requestId].result);
    // If not, start the request
    var parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (error) {
      return deferred.reject(error);
    }
    if (parsedUrl.protocol === 'file:') {
      if (!self.localFiles) {
        return deferred.reject(new Error('Tried to fetch a local file without enabling localFiles: ' + url));
      }
      var filePath;
      try {
        filePath = fileURLToPath(url);
      } catch (error) {
        return deferred.reject(error);
      }
      fs.readFile(filePath, function (error, buffer) {
        if (error) {
          error.message = 'Request failed: ' + url + ' (' + error.message + ')';
          return onResponse(error);
        }
        self.emit('downloaded', { url: url, totalBytes: buffer.length });
        onResponse(null, { responseUrl: url, statusCode: 200, headers: { 'content-type': 'application/octet-stream' } }, buffer);
      });
      self._active[requestId] = { request: { abort: function () {} }, result: deferred.promise };
      self._pending++;
      return;
    }
    var activeRequest;
    var headers = conditionalHeaders || baseHeaders;
    var settings = { hostname: parsedUrl.hostname, port: parsedUrl.port, path: parsedUrl.pathname + parsedUrl.search, headers: headers, timeout: 5000, method: method },
      executionResponse = function (res) {
        var encoding = res.headers['content-encoding']
        var responseStream = res;
        if (encoding && encoding == 'gzip') {
          responseStream = res.pipe(zlib.createGunzip());
        } else if (encoding && encoding == 'deflate') {
          responseStream = res.pipe(zlib.createInflate())
        }
        var chunks = [];
        var totalBytes = 0;
        //measure bytes downloaded
        res.on('data', function (chunk) {
          totalBytes += chunk.length;
        });
        //extracted chunks to be added to the array
        responseStream.on('data', function (chunk) {
          chunks.push(chunk);
        });
        res.on('error', function (error) {
          onResponse(error);
        });
        responseStream.on('end', function () {
          self.emit('downloaded', { url: url, totalBytes: totalBytes });
          onResponse(null, res, Buffer.concat(chunks));
        })
      };
    if (parsedUrl.protocol === 'https:') {
      activeRequest = https.request(settings, executionResponse);
    } else if (parsedUrl.protocol === 'http:') {
      activeRequest = http.request(settings, executionResponse);
    } else {
      console.error('WARNING: Only http or https supported. Not ' + parsedUrl.protocol);
      deferred.reject(url + ' not using a protocol we can handle');
    }
    if (activeRequest) {
      activeRequest.on('error', function (e) {
        deferred.reject(e.message);
      });
      activeRequest.end();
      // Mark the request as active
      self._active[requestId] = { request: activeRequest, result: deferred.promise };
      self._pending++;
    }
  }

  // Response callback
  function onResponse(error, response, bodyBuffer) {
    // Remove the request from the active list
    delete self._active[requestId];
    self._pending--;
    self.emit('response', url);
    // Schedule a possible pending call
    var next = self._queue.shift();
    if (next) {
      process.nextTick(next);
    }

    // Return result through the deferred
    if (error) {
      if (error.code === "ETIMEDOUT") {
        console.error("retrying: " + url);
        return deferred.resolve(self.request(url, method, options));
      } else {
        return deferred.reject(new Error(error));
      }
    }
    if (response.statusCode >= 500) {
      return deferred.reject(new Error('Request failed: ' + url));
    }
    if (cached && response.statusCode === 304) {
      // The server confirmed our stored copy is still good: refresh its freshness information and hand it out
      return cache.revalidated(method, url, baseHeaders, cached, { statusCode: 304, headers: response.headers })
        .then(deferred.resolve, deferred.reject);
    }
    var contentType = /^[^;]+/.exec(response.headers['content-type'] || 'text/html')[0];
    // for the url, take the last redirect url that can be found if there was a redirect
    // body is decoded as text for the (majority) text-based formats; bodyBuffer keeps
    // the raw bytes around for binary formats such as Jelly-RDF
    var responseObject = { url: response.responseUrl, type: contentType, body: bodyBuffer.toString('utf8'), bodyBuffer: bodyBuffer, statusCode: response.statusCode, headers: response.headers };
    if (cache && response.responseUrl && response.responseUrl.replace(/#.*/, '') === url.replace(/#.*/, '')) {
      // Only cache what was served from the requested URL itself; the cache decides on storability
      // (Cache-Control: no-store, status code, ...) following HTTP caching semantics
      return cache.put(method, url, baseHeaders, responseObject)
        .then(function () { deferred.resolve(responseObject); }, function () { deferred.resolve(responseObject); });
    }
    deferred.resolve(responseObject);
  }

  // Execute if possible, queue otherwise
  var queueOrExecute = function () {
    if (self._pending < self._maxParallel) {
      execute();
    } else {
      self._queue.push(execute);
    }
  }

  // Before executing, let's check whether it is available in cache (only cache GET and HEAD requests though,
  // and never local files, which have no cache semantics)
  if (cache && (method === 'GET' || method === 'HEAD') && !/^file:/i.test(url)) {
    cache.lookup(method, url, baseHeaders).then(function (result) {
      if (result.state === 'fresh') {
        self.emit('cache-hit', url);
        deferred.resolve(result.response);
      } else {
        self.emit('cache-miss', url);
        if (result.state === 'stale') {
          cached = result.entry;
          conditionalHeaders = result.headers;
        }
        queueOrExecute();
      }
    }, function () {
      self.emit('cache-miss', url);
      queueOrExecute();
    });
  } else {
    queueOrExecute();
  }

  return deferred.promise;
};

// Returns a promise for {stream, url, statusCode, type}, resolved as soon as
// the response headers arrive, without ever buffering the body -- for
// sources too large to hold in memory (see issue #59). Deliberately a
// separate, simpler method rather than a mode of request(): it bypasses the
// cache and the _maxParallel queue (a streamed download is a one-off, and
// caching a stream's bytes would defeat the point), skips the ETIMEDOUT
// retry (retrying midway through a partially-consumed stream isn't
// meaningful the way retrying a not-yet-started buffered request is), and
// content-type resolution here can only use the declared header -- byte-
// sniffing (gzip/zstd magic numbers) needs the body, which this never reads
// on the caller's behalf.
HttpFetcher.prototype.getStream = function (url) {
  var self = this;
  var deferred = q.defer();
  this.emit('request', url);

  var parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch (error) {
    deferred.reject(error);
    return deferred.promise;
  }

  if (parsedUrl.protocol === 'file:') {
    if (!self.localFiles) {
      deferred.reject(new Error('Tried to fetch a local file without enabling localFiles: ' + url));
      return deferred.promise;
    }
    var filePath;
    try {
      filePath = fileURLToPath(url);
    } catch (error) {
      deferred.reject(error);
      return deferred.promise;
    }
    var fileStream = fs.createReadStream(filePath);
    fileStream.once('error', function (error) {
      deferred.reject(new Error('Request failed: ' + url + ' (' + error.message + ')'));
    });
    fileStream.once('open', function () {
      deferred.resolve({ stream: fileStream, url: url, statusCode: 200, type: 'application/octet-stream' });
    });
    return deferred.promise;
  }

  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    deferred.reject(new Error(url + ' not using a protocol we can handle'));
    return deferred.promise;
  }

  var headers = self._buildHeaders(self._accept, self._customHeaders);
  var settings = { hostname: parsedUrl.hostname, port: parsedUrl.port, path: parsedUrl.pathname + parsedUrl.search, headers: headers, timeout: 5000, method: 'GET' };
  var transport = parsedUrl.protocol === 'https:' ? https : http;

  var activeRequest = transport.request(settings, function (res) {
    self.emit('response', url);
    if (res.statusCode >= 500) {
      res.resume(); // drain so the socket can be released
      return deferred.reject(new Error('Request failed: ' + url));
    }
    var encoding = res.headers['content-encoding'];
    var responseStream = res;
    if (encoding === 'gzip') {
      responseStream = res.pipe(zlib.createGunzip());
    } else if (encoding === 'deflate') {
      responseStream = res.pipe(zlib.createInflate());
    }
    var contentType = /^[^;]+/.exec(res.headers['content-type'] || 'text/html')[0];
    deferred.resolve({ stream: responseStream, url: res.responseUrl, statusCode: res.statusCode, type: contentType, contentDisposition: res.headers['content-disposition'] });
  });
  activeRequest.on('error', function (e) {
    deferred.reject(e.message);
  });
  activeRequest.end();

  return deferred.promise;
};

HttpFetcher.prototype.getCacheStats = function () {
  return this._cache ? this._cache.getStats() : {};
};

// Cancels all pending requests
HttpFetcher.prototype.cancelAll = function () {
  for (var id in this._active)
    this._active[id].request.abort();
  this._active = {};
  this._queue = [];
};

module.exports = HttpFetcher;
