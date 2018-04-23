var util = require("util");
var q = require('q');
var Fetcher = require("./NodeHttpFetcher.js");
var N3 = require('n3');
var JsonldToRDF = require('./JsonldToRDF');
var RDFaToRDF = require('./RDFaToRDF');
var EntityStore = require('./EntityStore');
const cheerio = require('cheerio');
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
        //Parses extra JSON-LD snippets in the page
        const $ = cheerio.load(response.body);
        var promises = [];
        var promiseIndex = 0;
        $("script[type*='application/ld+json']").each((index, val) => {
          promises[index] = q.defer();
          (new JsonldToRDF({documentIRI: response.url})).parse(val.children[0].data, (error, triple, newPrefixes) => {
            if (triple) {
              triples.push(triple);
            } else if (error) {
              //If there’s an error in this promise, just resolve it without anything else
              promises[promiseIndex].resolve();
              promiseIndex++;
            } else {
              promises[promiseIndex].resolve();
              promiseIndex++;
            }
          });
        });
        
        //Parses the RDFa
        var parser = new RDFaToRDF({documentIRI: response.url});
        parser.parse(response.body, (error, triple, newPrefixes) => {
          this.emit('parsed', response.url);
          if (error) {
            promise.reject(error);
          } else if (triple) {
            triples.push(triple);
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
