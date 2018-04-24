var util = require("util");
var q = require('q');
var Fetcher = require("./NodeHttpFetcher.js");
var N3 = require('n3');
var JsonldToRDF = require('./JsonldToRDF');
var RDFaToRDF = require('./RDFaToRDF');
var EntityStore = require('./EntityStore');
const {JSDOM} = require("jsdom");

const EventEmitter = require('events');
/** This is the common part for both browser and NodeJS */
module.exports = class extends EventEmitter {
  constructor (options) {
    super();
    this.prefixes = {};
    var accept = 'application/trig;q=1.0,application/n-quads;q=0.7,text/turtle;q=0.6,application/n-triples;q=0.3,application/ld+json;q=0.3,text/n3;q=0.2';
    if (options && options.headers) {
      this.fetcher = new Fetcher(accept, options.headers);
    } else {
      this.fetcher = new Fetcher(accept);
    }
    //forward events on this class
    this.fetcher.on("cache-miss", obj => {
      this.emit("cache-miss",obj);
    });
    this.fetcher.on("cache-hit", obj => {
      this.emit("cache-hit",obj);
    });
    this.fetcher.on("downloaded", obj => {
      this.emit("downloaded",obj);
    });
  }

  addPrefix (prefix, uri) {
    this.prefixes[prefix] = uri;
  }

  getCacheStats () {
    return this.fetcher.getCacheStats();
  }

  /**
   * Can take arrays of rdfjs quads as arguments and returns 1 array in the end
   */
  /* Code is never used -- commenting
  joinQuads () {
    var joined = [];
    for (var i = 0; i < arguments.length; i++) {
      var arg = arguments[i];
      joined = joined.concat(this.prependToBlankNodeNames(i, arguments[i]));
    }
    return joined;
  }

  prependToBlankNodeNames (string, quads) {
    for (var i = 0; i < quads.length; i ++) {
      quads[i] = this.prependToBlankNodeNamesQuad(quads[i]);
    }
    return quads;
  }*/
  
  /**
   * Prepends specific string to blanknode in order to make sure names remain unique when merging different sources
   * Contains workaround for https://github.com/digitalbazaar/jsonld.js/issues/244: removed "_:"
   */
  prependToBlankNodeNamesQuad (string, quad) {
    if (quad.subject.termType === 'BlankNode') {
      quad.subject.value = string + '-' + quad.subject.value.substr(2);
    }
    if (quad.predicate.termType === 'BlankNode') {
      quad.predicate.value = string + '-' + quad.predicate.value.substr(2);
    }
    if (quad.object.termType === 'BlankNode') {
      quad.object.value = string + '-' + quad.object.value.substr(2);
    }
    if (quad.graph && quad.graph.termType === 'BlankNode') {
      quad.graph.value = string + '-' + quad.graph.value.substr(2);
    }
    return quad;
  }
  
  get (url) {
    this.emit('request', url);
    return this.fetcher.get(url).then((response) => {
      if (url !== response.url) {
        this.emit('redirect',{'from': url, 'to': response.url});
      }
      this.emit('response', response.url);
      var triples = [], prefixes = {}, promise = q.defer();
      if (response.type === 'application/ld+json' || response.type === 'application/json') {
        var parser = new JsonldToRDF({documentIRI: response.url});
        parser.parse(response.body, (error, triple, newPrefixes) => {
          this.emit('parsed', response.url);
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
        return promise.promise;
      } else if (response.type === 'text/html') {
        var promises = [];
        var promiseIndex = 0;

        //Parses extra JSON-LD snippets in the page
        var dom = new JSDOM(response.body); //In the browser, this is replaced with window.DOMParser
        var jsonldscriptelements = dom.window.document.querySelectorAll("script[type*='application/ld+json']");
        
        for (var index = 0; index < jsonldscriptelements.length; index++) {
          var tag = jsonldscriptelements[index];
          //TODO: what if there is no textContent and there is an src tag instead? Should this be supported?
          promises[index] = q.defer();
          var newTriples = [];
          (new JsonldToRDF({documentIRI: response.url})).parse(tag.textContent, (error, triple, newPrefixes) => {
            if (triple) {
              triples.push(this.prependToBlankNodeNamesQuad("jsonldsnippet-" + promiseIndex, triple));
            } else if (error) {
              //If there’s an error in this promise, just resolve it without anything else
              console.error('WARNING: an error was given while processing a JSON-LD snippet: ', error );
              promises[promiseIndex].resolve();
              promiseIndex++;
            } else {
              //Success! Let’s resolve it.
              promises[promiseIndex].resolve();
              promiseIndex++;
            }
          });
        }
        //Parses the RDFa
        var parser = new RDFaToRDF({documentIRI: response.url});
        parser.parse(response.body, (error, triple, newPrefixes) => {
          this.emit('parsed', response.url);
          if (error) {
            promise.reject(error);
          } else if (triple) {
            triples.push(this.prependToBlankNodeNamesQuad("rdfa-", triple));
          } else {
            prefixes = Object.assign(this.prefixes, prefixes);
            promise.resolve();
          }
          if (newPrefixes) {
            prefixes = Object.assign(prefixes, newPrefixes);
          }
        });
        
        var promises2 = [promise].concat(promises).map(promise => {return promise.promise});
        return q.all(promises2).then(() => {
          //console.log(triples);
          return { triples,
                   prefixes,
                   statusCode: response.statusCode,
                   url : response.url};
        });
      
      } else if (["application/trig","application/n-quads","text/turtle","application/n-triples","text/n3"].indexOf(response.type.toLowerCase()) > -1) {
        //Just try anything else using N3 parser
        //Parse N3, text/turtle, N-Quads, n-triples or trig and store in N3 Store
        var parser = new N3.Parser({documentIRI: response.url});
        parser.parse(response.body, (error, triple, newPrefixes) => {
          this.emit("parsed", response.url);
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
