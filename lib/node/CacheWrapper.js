const CacheableRequest = require('cacheable-request');

var CacheWrapper = {
  wrap: (protocols) => {
    // Wrap each protocol
    var nativeProtocols = {};
    var exports = {};
    for (let scheme in protocols) {
      let protocol = scheme + ":";
      let nativeProtocol = nativeProtocols[protocol] = protocols[scheme];
      let wrappedProtocol = exports[scheme] = Object.create(nativeProtocol);
      //Storage adapter right now: just in memory
      let cacheableRequest = new CacheableRequest(nativeProtocol.request, 'redis://localhost:6379');
      // Executes a request, enabling caching
      wrappedProtocol.request = function (options, callback) {
        var cacheReq = cacheableRequest(options, res => {
          if (res.fromCache) 
            wrappedProtocol.emit('cache-hit');
          else
            wrapperProtocol.emit('cache-miss');
          callback(res);
        });
        
        cacheReq.on('request', req => req.end());
        
        /*cacheReq.on('error', err => {
          if (err instanceof CacheableRequest.CacheError) {
            throw err; // Cache error
          } else if (err instanceof CacheableRequest.RequestError) {
            throw err; // Request function thrown
          }
        });
        cacheReq.on('request', req => {
          req.on('error', err => {
            console.error(err);
            throw err;
          }); // Request error emitted
          req.end();
        });*/
        
        cacheReq.end = function () {
          //Not sure what should go here
          return;
        };
        return cacheReq;
      }
    }
    return exports;
  }
};

module.exports = CacheWrapper;
