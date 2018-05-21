const decompressResponse = require('decompress-response');
const URL = require('url');
var DecompressWrapper = {
  request: (options, responseCallback) => {
    if (typeof options === "string") {
      options = URL.parse(options);
    }
    return options.nativeProtocols[options.protocol].request(options, response => {
      responseCallback(decompressResponse(response));
    });
  },
  wrap: (protocols) => {
    // Wrap each protocol
    var nativeProtocols = {};
    var exports = {};
    for (let scheme in protocols) {
      //Using let to guard scope here
      let protocol = scheme + ":";
      var nativeProtocol = nativeProtocols[protocol] = protocols[scheme];
      var wrappedProtocol = exports[scheme] = Object.create(nativeProtocol);
      
      // Executes a request, decompressing the response
      wrappedProtocol.request = function (options, callback) {
        if (typeof options === "string") {
          options = URL.parse(options);
        } else {
          //add a protocol property in the url object
          options = Object.assign({
            protocol: protocol
          }, options);
        }
        options.nativeProtocols = nativeProtocols;
        return DecompressWrapper.request(options, callback);
      };
      
      // Executes a GET request, decompressing the response
      wrappedProtocol.get = function (options, callback) {
        var request = wrappedProtocol.request(options, callback);
        request.end();
        return request;
      };
    }
    return exports;
  }
};

module.exports = DecompressWrapper;
