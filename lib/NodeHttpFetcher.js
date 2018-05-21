/*! @license ©2013 Ruben Verborgh, 2016 Pieter Colpaert - Data Science Lab / iMinds / Ghent University, 2017-2018 Pieter Colpaert - IDLab / imec / Ghent University */
/** A HttpFetcher downloads documents through HTTP. The NodeHttpFetcher implements this for nodejs useage (for the browser, check out BrowserHttpFetcher.js) */

var q = require('q'),
    util = require('util'),
    EventEmitter = require('events'),
    http = require('http'),
    https = require('https');

const URL = require('url');

// Creates a new HttpFetcher
function HttpFetcher(accept, maxParallel, enableCache, customHeaders) {
  EventEmitter.call(this);
  
  this._accept = accept || 'application/ld+json;q=1.0';
  this._enableCache = true;
  this._queue = [];    // Queue of request execution functions
  this._active = {};   // Hash of active requests
  this._pending = 0;   // The number of currently active requests
  this._maxParallel = 5; // Only execute this many requests in parallel
  this._customHeaders = {}; // Additional HTTP headers for Connection fetching requests
  
  // Check for params types one by one to allow backwards compatibility
  if (typeof maxParallel !== 'undefined') {
    if (typeof maxParallel !== 'number') {
      if(typeof maxParallel !== 'boolean') {
        this._customHeaders = maxParallel;
      } else {
        this._enableCache = maxParallel;
      }
    } else {
      this._maxParallel = maxParallel;
    }
  }

  //Shift parameters if necessary
  if (typeof enableCache !== 'undefined') {
    if (typeof enableCache !== 'boolean') {
      this._customHeaders = enableCache;
    } else {
      this._enableCache = enableCache;
    }
  }

  //TODO: how will we choose the cache store?
  if (this._enableCache) {
    var protocolsAfterCache = require('./node/CacheWrapper.js').wrap({http,https});
    http = protocolsAfterCache.http;
    https = protocolsAfterCache.https;
  }
  //Also follow redirects
  var protocolsAfterRedirect = require('follow-redirects').wrap({http,https});
  //Also decompress after redirects + cache
  var protocolsAfterDecompress = require('./node/DecompressWrapper.js').wrap({http: protocolsAfterRedirect.http, https: protocolsAfterRedirect.https});
  http = protocolsAfterDecompress.http;
  https = protocolsAfterDecompress.https;
  
  if(typeof customHeaders !== 'undefined') {
    this._customHeaders = customHeaders;
  }
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
    var parsedUrl = URL.parse(url);
    var activeRequest;
    var headers = {
      'Accept': self._accept,
      'Accept-Encoding': 'gzip, deflate',
      'User-Agent': 'Linked Data Fetch for NodeJS',
    };
    if (Object.keys(self._customHeaders).length > 0) {
      for (let [k, v] of Object.entries(self._customHeaders)) {
        headers[k] = v;
      }
    }
    var settings = parsedUrl;
    settings.headers = headers;
    settings.timeout = 5000;
    settings.method = method;
    var executionResponse = function (res) {
      var responseStream = res;
      var responseBody = '';
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
        onResponse(null, res, chunks.join(''));
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
  function onResponse(error, response, body) {
    var responseUrl = response.responseUrl;
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
    var responseObject = { url: response.responseUrl, type: contentType, body: body, statusCode: response.statusCode };
    deferred.resolve(responseObject);
  }

  // Execute if possible, queue otherwise
  if (self._pending < self._maxParallel) {
    execute();
  } else {
    self._queue.push(execute);
  }
  return deferred.promise;
};

// Cancels all pending requests
HttpFetcher.prototype.cancelAll = function () {
  for (var id in this._active)
    this._active[id].request.abort();
  this._active = {};
  this._queue = [];
};

module.exports = HttpFetcher;
