var util = require("util");
var q = require('q');
var Fetcher = require("./NodeHttpFetcher.js");
var N3 = require('n3');
var JsonldToRDF = require('./JsonldToRDF');
var RDFaToRDF = require('./RDFaToRDF');
var EntityStore = require('./EntityStore');

/** This is the common part for both browser and NodeJS */
module.exports = class {
  constructor (options) {
    this.prefixes = {};
    if (options) {
//      console.log(options);
    }
    var accept = 'application/trig;q=1.0,application/n-quads;q=0.7,text/turtle;q=0.6,application/n-triples;q=0.3,application/ld+json;q=0.3,text/n3;q=0.2';
    this.fetcher = new Fetcher(accept, 10);
  }

  addPrefix (prefix, uri) {
    this.prefixes[prefix] = uri;
  }
  
  get (url) {
    return this.fetcher.get(url).then((response) => {
      var triples = [], prefixes = {}, promise = q.defer();
      if (response.type === 'application/ld+json' || response.type === 'text/html') {
        var parser;
        if (response.type === 'application/ld+json') {
          parser = new JsonldToRDF();
        } else {
          //response.type === 'text/html'
          parser = new RDFaToRDF();
        }
        parser.parse(response.body, (error, triple, newPrefixes) => {
          if (error) {
            promise.reject(error);
          } else if (triple) {
            triples.push(triple);
          } else {
            prefixes = Object.assign(this.prefixes, prefixes);
            promise.resolve({ triples,
                              prefixes,
                              statusCode: response.statusCode,
                              url : response.url});
          }
          if (newPrefixes) {
            prefixes = Object.assign(prefixes, newPrefixes);
          }
        });
      } else if (["application/trig","application/n-quads","text/turtle","application/n-triples","text/n3"].indexOf(response.type.toLowerCase()) > -1) {
        //Just try anything else using N3 parser
        //Parse N3, text/turtle, N-Quads, n-triples or trig and store in N3 Store
        var parser = new N3.Parser();
        parser.parse(response.body, (error, triple, newPrefixes) => {
          if (error) {
            promise.reject(error);
          } else if (triple) {
            triples.push(triple);
          } else {
            prefixes = Object.assign(prefixes, this.prefixes);
            promise.resolve({ triples: triples,
                              prefixes: prefixes,
                              statusCode: response.statusCode,
                              url : response.url});
          }
          if (newPrefixes) {
            prefixes = Object.assign(prefixes, newPrefixes);
          }
        });
      } else {
        //No parser found
        promise.resolve({
          statusCode: response.statusCode,
          triples: triples,
          prefixes: prefixes,
          url : response.url,
          error: 'Cannot parse ' + response.type
        });
      }
      return promise.promise;
    });
  }
};
