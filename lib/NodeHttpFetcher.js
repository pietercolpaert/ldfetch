/*! @license ©2013 Ruben Verborgh, 2016 Pieter Colpaert - Data Science Lab / iMinds / Ghent University */
/** A HttpFetcher downloads documents through HTTP. The NodeHttpFetcher implements this for nodejs useage (for the browser, check out BrowserHttpFetcher.js) */

var q = require('q'),
    http = require('follow-redirects/http'),
    util = require('util'),
    URLParser = require('url'),
    zlib = require('zlib'),
    Cache = require('node-cache'),
    Wreck = require('wreck'),
    EventEmitter = require('events');

// Creates a new HttpFetcher
function HttpFetcher(maxParallel, enableCache) {
  EventEmitter.call(this);
  this._enableCache = enableCache || false;
  this._cache = new Cache({
    stdTTL: 60, //standard time to live is 60 seconds
    checkperiod: 60 //will delete entries each 1 minute
  });
  this._queue = [];    // Queue of request execution functions
  this._active = {};   // Hash of active requests
  this._pending = 0;   // The number of currently active requests
  this._maxParallel = maxParallel || 10; // Only execute this many requests in parallel
}

util.inherits(HttpFetcher, EventEmitter);

// Returns a promise for the HTTP GET request's result
HttpFetcher.prototype.get = function (url) {
  return this.request(url, 'GET');
};

// Returns a promise for the HTTP request's result
HttpFetcher.prototype.request = function (url, methodName) {
  this.emit('request', url);
  var method = methodName || 'GET', requestId = methodName + url;

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
    var parsedUrl = URLParser.parse(url);
    var headers = { 'Accept': 'application/ld+json;q=1.0',
                    'User-Agent' : 'lc-client command line interface',
                    'Accept-Encoding': 'gzip, deflate'
                  },
        settings = { hostname: parsedUrl.hostname, port: parsedUrl.port, path: parsedUrl.path, headers: headers, timeout: 5000, method: method},
        activeRequest = http.request(settings, function (res) {
          var encoding = res.headers['content-encoding']
          var responseStream = res;
          if (encoding && encoding == 'gzip') {
            responseStream = res.pipe(zlib.createGunzip());
          } else if (encoding && encoding == 'deflate') {
            responseStream = res.pipe(zlib.createInflate())
          }
          var responseBody = '';
          var chunks = [];
          var totalBytes = 0;
          responseStream.on('data', function (chunk) {
            totalBytes += chunk.length;
            chunks.push(chunk);
          });
          res.on('error', function (error) {
            onResponse(error);
          });
          responseStream.on('end', function () {
            self.emit('downloaded',{url:url, totalBytes:totalBytes});
            onResponse(null, res, chunks.join(''));
          })
        });
    
    activeRequest.on('error', function (e) {
      deferred.reject(e.message);
    });
    activeRequest.end();
    // Mark the request as active
    self._active[requestId] = { request: activeRequest, result: deferred.promise };
    self._pending++;
  }

  // Response callback
  function onResponse(error, response, body) {
    var responseUrl;
    // Walkaround for https://github.com/olalonde/follow-redirects/issues/32
    if (response.fetchedUrls.length > 1) {
      responseUrl = response.fetchedUrls[0];
    } else {
      responseUrl = url;
    }
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
        return deferred.resolve(self.get(url));
      } else {
        return deferred.reject(new Error(error));
      }
    }
    if (response.statusCode >= 500) {
      return deferred.reject(new Error('Request failed: ' + url));
    }
    var contentType = /^[^;]+/.exec(response.headers['content-type'] || 'text/html')[0];
    // for the url, take the last redirect url that can be found if there was a redirect
    var responseObject = { url: responseUrl, type: contentType, body: body, status: response.statusCode };
    //parse caching headers
    var cacheHeader = {};
    if (response.headers['cache-control']) {
      Wreck.parseCacheControl(response.headers['cache-control']);
    }
    var maxAge = 6000;
    if (cacheHeader['max-age']) {
      maxAge = cacheHeader['max-age'];
    }
    if (self._enableCache && !cacheHeader['no-cache']) {
      self._cache.set(url, responseObject, maxAge*1000,  function (error, success) {
        if (error || !success) {
          console.error('Warning: unable to set key in cache ' + url);
        }
        deferred.resolve(responseObject);
      });
    } else {
      deferred.resolve(responseObject);
    }
  }

  // Execute if possible, queue otherwise
  var queueOrExecute = function () {
    if (self._pending < self._maxParallel) {
      execute();
    } else {
      self._queue.push(execute);
    }
  }
  
  // Before executing, let's check whether it is available in cache (only cache GET and HEAD requests though)
  if (this._enableCache && (method === 'GET' || method === 'HEAD')) {
    self._cache.get(url, function (error, value) {
      if (error || !value) {
        queueOrExecute();
      } else {
        deferred.resolve(value);
      }
    });
  } else {
    queueOrExecute();
  }
  
  return deferred.promise;
};

HttpFetcher.prototype.getCacheStats = function () {
  self._cache.getStats();
};

// Cancels all pending requests
HttpFetcher.prototype.cancelAll = function () {
  for (var id in this._active)
    this._active[id].request.abort();
  this._active = {};
  this._queue = [];
};

module.exports = HttpFetcher;
