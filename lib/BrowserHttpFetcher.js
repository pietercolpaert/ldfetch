/*! @license ©2013 Ruben Verborgh, 2016 Pieter Colpaert - Data Science Lab / iMinds / Ghent University */
/** A HttpFetcher downloads documents through HTTP. This is the browser implementation */

var q = require('q'),
  http = require('http'),
  https = require('https'),
  util = require('util'),
  URLParser = require('url'),
  EventEmitter = require('events');

// Creates a new HttpFetcher - maxParallel is handled by the browser, so we'll ignore it
function HttpFetcher(accept, customHeaders) {
  EventEmitter.call(this);
  this._accept = accept || 'application/ld+json;q=1.0';
  this._customHeaders = customHeaders || {};
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

  var self = this, deferred = q.defer();
  var parsedUrl = URLParser.parse(url);
  var headers = { 'Accept': this._accept };
  if (Object.keys(self._customHeaders).length > 0) {
    for (let [k, v] of Object.entries(self._customHeaders)) {
      headers[k] = v;
    }
  }
  var settings = { hostname: parsedUrl.hostname, port: parsedUrl.port, path: parsedUrl.path, headers: headers, withCredentials: false, method: method };

  var executionResponse = function (res) {
    var responseStream = res;
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
      //TODO: this count is after extraction from e.g., gzip...
      self.emit('downloaded', { url: url, totalBytes: totalBytes });
      onResponse(null, res, chunks.join(''));
    })
  };
  var request = {};
  if (parsedUrl.protocol === 'https:') {
    request = https.request(settings, executionResponse);
  } else if (parsedUrl.protocol === 'http:') {
    request = http.request(settings, executionResponse);
  } else {
    console.error('Only http or https supported. Not ' + parsedUrl.protocol);
  }
  request.on('error', function (e) {
    deferred.reject(e);
  });
  request.end(null);

  // Response callback
  function onResponse(error, response, body) {
    // Hack to get the in browser response URL after redirects
    // Different responses with 2 different modes: fetch and xhr
    // See also: https://github.com/jhiesey/stream-http/issues/39
    var responseUrl;
    if (request._xhr) {
      responseUrl = request._xhr.responseURL;
    } else {
      responseUrl = request._fetchResponse.url;
    }
    self.emit('response', responseUrl);
    // Return result through the deferred
    if (error) {
      return deferred.reject(new Error(error));
    }
    if (response.statusCode >= 500) {
      return deferred.reject(new Error('Request failed: ' + url));
    }
    var contentType = /^[^;]+/.exec(response.headers['content-type'] || 'text/html')[0];
    // for the url, take the last redirect url that can be found if there was a redirect
    deferred.resolve({ url: responseUrl, type: contentType, body: body, status: response.statusCode });
  }
  return deferred.promise;
};

// Cancels all pending requests
HttpFetcher.prototype.cancelAll = function () {
};

module.exports = HttpFetcher;
