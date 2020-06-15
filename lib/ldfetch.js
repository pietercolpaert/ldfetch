const util = require("util");
const q = require('q');
const Fetcher = require("./NodeHttpFetcher.js");
const jsonldframe = require('jsonld').frame;
const rdfParser = require("rdf-parse").default;
const EventEmitter = require('events');
const textStream = require('string-to-stream')

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
    var accept = 'application/trig;q=1.0,application/n-quads,application/ld+json;q=.9,application/rdf+xml;q=.8,text/turtle,application/n-triples';
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
    return jsonldframe(objects, frame);
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
      //Awaiting https://github.com/rubensworks/rdf-parse.js/issues/22
      prefixes = this.prefixes;
      rdfParser.parse(textStream(response.body),  { contentType: response.type, baseIRI: response.url })
        .on('data', (quad) => triples.push(quad))
        .on('error', (error) => promise.reject(error))
        .on('end', () => {
          this.emit('parsed', response.url);
          promise.resolve({ triples,
                            prefixes,   
                            statusCode: response.statusCode,
                            url: response.url}
                         );
        });
      return promise.promise;
    });
  }
};
