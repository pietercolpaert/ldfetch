/*! @license ©2013 Ruben Verborgh, 2016 Pieter Colpaert - Data Science Lab / iMinds / Ghent University */
/** A HttpFetcher downloads documents through HTTP. This is the browser implementation */

var q = require('q'),
  http = require('http'),
  https = require('https'),
  util = require('util'),
  URLParser = require('url'),
  EventEmitter = require('events');

// Creates a new HttpFetcher - maxParallel is handled by the browser, so we'll ignore it
function HttpFetcher(accept, customHeaders, proxy) {
  EventEmitter.call(this);
  this._accept = accept || 'application/ld+json;q=1.0';
  this._customHeaders = customHeaders || {};
  this._proxy = proxy || '';
}

util.inherits(HttpFetcher, EventEmitter);

// Browsers block (mixed content) any http:// XHR/fetch made from a page
// loaded over https -- upgrading here, rather than letting the request
// silently fail, gives the resource a chance to work if it also happens to
// support https, which the overwhelming majority of hosts do today. Only
// applies when this page itself is https; on a plain http page (e.g. local
// development/tests), there's no mixed-content restriction to route
// around, and forcing https could break a target that's genuinely only
// reachable over http in that context.
function upgradeIfMixedContent(url) {
  if (typeof window !== 'undefined' && window.location && window.location.protocol === 'https:' && /^http:\/\//i.test(url)) {
    return url.replace(/^http:/i, 'https:');
  }
  return url;
}

// Returns a promise for the HTTP GET request's result
HttpFetcher.prototype.get = function (url) {
  return this.request(url, 'GET');
};

// Returns a promise for the HTTP request's result
HttpFetcher.prototype.request = function (url, methodName) {
  url = upgradeIfMixedContent(url);
  this.emit('request', url);
  var method = methodName || 'GET', requestId = methodName + url;
  var requestUrl = this._proxy + url;

  var self = this, deferred = q.defer();
  var parsedUrl = URLParser.parse(requestUrl);
  var headers = { 'Accept': this._accept };
  if (Object.keys(self._customHeaders).length > 0) {
    for (let [k, v] of Object.entries(self._customHeaders)) {
      headers[k] = v;
    }
  }
  var settings = { hostname: parsedUrl.hostname, port: parsedUrl.port, path: parsedUrl.path, headers: headers, withCredentials: false, method: method };

  var executionResponse = function (res) {
    var responseStream = res;
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
      onResponse(null, res, Buffer.concat(chunks));
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
  function onResponse(error, response, bodyBuffer) {
    // Hack to get the in browser response URL after redirects
    // Different responses with 2 different modes: fetch and xhr
    // See also: https://github.com/jhiesey/stream-http/issues/39
    var responseUrl;
    if (request._xhr) {
      responseUrl = request._xhr.responseURL;
    } else {
      responseUrl = request._fetchResponse.url;
    }
    // The proxy URL is only a transport detail. Strip it again so redirects,
    // response events, and relative RDF IRIs continue to use the source URL.
    if (self._proxy && responseUrl.indexOf(self._proxy) === 0) {
      responseUrl = responseUrl.slice(self._proxy.length);
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
    deferred.resolve({ url: responseUrl, type: contentType, body: bodyBuffer.toString('utf8'), bodyBuffer: bodyBuffer, status: response.statusCode });
  }
  return deferred.promise;
};

// Streaming (see NodeHttpFetcher.js's getStream(), for issue #59) needs
// Node's http/https stack; the browser playground solves large-file
// streaming its own way, directly against fetch()/ReadableStream.
HttpFetcher.prototype.getStream = function (url) {
  return q.reject(new Error('getStream() is not supported in the browser; use get() instead.'));
};

// Cancels all pending requests
HttpFetcher.prototype.cancelAll = function () {
};

module.exports = HttpFetcher;
