const util = require("util");
const q = require('q');
const Fetcher = require("./NodeHttpFetcher.js");
const N3 = require('n3');
const RDFXMLParser = require('rdfxmlprocessor');
const {DOMParser} = require('xmldom');
const JsonldToRDF = require('./JsonldToRDF');
const RDFaToRDF = require('./RDFaToRDF');
const EntityStore = require('./EntityStore');
const NodeHTMLParser = require('./NodeHTMLParser');
const jsonld = require('jsonld');
const DataFactory = require('@rdfjs/data-model')

const EventEmitter = require('events');
/** This is the common part for both browser and NodeJS */
module.exports = class extends EventEmitter {
  constructor (options) {
    super();
    this.prefixes = {};
    //We like quads, so preference to serializations that we can parse fast with quads
    //Then comes JSON-LD, which is slower to parse
    //Then comes rdf/xml, turtle and n-triples, which we support in a fast manner, but it doesn’t contain named graphs
    //We also support HTML, but that’s really slow
    //We also support N3 and parse it quite fast, but we won’t do anything special with the N3 rules, so put it to low q
    var accept = 'application/trig;q=1.0,application/n-quads;q=1.0,application/ld+json;q=0.9,application/rdf+xml; q=0.8,text/turtle;q=0.8,application/n-triples;q=0.8,text/html;q=0.5,text/n3;q=0.2';
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

  async frame (triples, frame) {
    if (typeof triples === 'string') {
      triples = await this.get(triples).then(response => {
        return response.triples;
      });
    }
    var objects = {"@graph": []};
    var graphs = {};
    for (var triple of triples) {
      //Json-LD lib uses underscores when blanknode
      if (triple.subject.termType === 'BlankNode') {
        triple.subject.value = '_:' + triple.subject.value;
      }
      if (triple.predicate.termType === 'BlankNode') {
        triple.predicate.value = '_:' + triple.predicate.value;
      }
      if (triple.object.termType === 'BlankNode') {
        triple.object.value = '_:' + triple.object.value;
      }
      if (triple.graph.termType === 'BlankNode') {
        triple.graph.value = '_:' + triple.graph.value;
      }
      if (triple.graph.value && !graphs[triple.graph.value])
        graphs[triple.graph.value] = {"@id": triple.graph.value, "@graph" : []};
      var obj = {
        "@id" : triple.subject.value,  
      };
      if (triple.object.termType === 'Literal') {
        obj[triple.predicate.value] = {"@value" : triple.object.value};
        if (triple.predicate.language)
          obj[triple.predicate.value]["@language"] = triple.object.language;
        if (triple.object.datatype)
          obj[triple.predicate.value]["@type"] = triple.object.datatype.value;
      } else if (triple.predicate.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type') {
        obj["@type"] = triple.object.value;
      } else {
        obj[triple.predicate.value] = {"@id": triple.object.value};
      }
      if (!triple.graph.value) {
        objects["@graph"].push(obj);
      } else {
        graphs[triple.graph.value]["@graph"].push(obj);
      }
    }
    objects["@graph"].push(Object.values(graphs));
    return jsonld.frame(objects, frame);
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
        var parser = new JsonldToRDF({documentIRI: response.url, factory: DataFactory});
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
        var document = NodeHTMLParser(response.body, response.url); //In the browser, this is replaced with BrowserHTMLParser
        var jsonldscriptelements = document.querySelectorAll("script[type*='application/ld+json']");
        
        for (var index = 0; index < jsonldscriptelements.length; index++) {
          var tag = jsonldscriptelements[index];
          //TODO: what if there is no textContent and there is an src tag instead? Should this be supported?
          promises[index] = q.defer();
          var newTriples = [];
          (new JsonldToRDF({documentIRI: response.url})).parse(tag.textContent, (error, triple, newPrefixes) => {
            if (triple) {
              triples.push(triple);
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
        var parser = new RDFaToRDF({documentIRI: response.url, factory: DataFactory});
        parser.parse(document, (error, triple, newPrefixes) => {
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
        //Parse N3, text/turtle, N-Quads, n-triples or trig
        var parser = new N3.Parser({documentIRI: response.url, factory: DataFactory});
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
      } else if (["application/rdf+xml"].indexOf(response.type.toLowerCase()) > -1) {
        //RDFXML
        var parser = new RDFXMLParser();
        //both base and graphname to the response url
        parser.parse(new DOMParser().parseFromString(response.body), response.url, response.url, (triple) => {
          this.emit("parsed", response.url);
          if (triple) {
            triples.push(triple);
          } else {
            promise.resolve({ triples: triples,
                              statusCode: response.statusCode,
                              url : response.url});
          }
        });
      } else {
        //No parser found -- TODO: let’s try any parser until we find triples! The fastest first, the slowest last.
        
        //Just resolve the promise
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
