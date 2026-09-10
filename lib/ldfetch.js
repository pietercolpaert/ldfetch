const util = require("util");
const q = require('q');
const Fetcher = require("./NodeHttpFetcher.js");
const RdfParsers = require("./RdfParsers.js");
const EventEmitter = require('events');

/** This is the common part for both browser and NodeJS */
module.exports = class extends EventEmitter {
  constructor (options) {
    super();
    this.prefixes = {};
    //We like quads, so preference to serializations that we can parse fast with quads
    //Jelly-RDF is a compact binary format, so give it a decent priority when a server offers it
    //Then comes JSON-LD, which is slower to parse
    //Then comes rdf/xml, turtle and n-triples, which we support in a fast manner, but it doesn’t contain named graphs
    //We also support HTML (RDFa/Microdata), SHACL Compact syntax, but that’s really slow/niche, so we don’t advertise those
    //We also support N3 and parse it quite fast, but we won’t do anything special with the N3 rules, so put it to low q
    var accept = 'application/trig;q=1.0,application/x-jelly-rdf;q=0.95,application/ld+json;q=0.9,application/rdf+xml;q=0.8,text/turtle';
    this.fetcher = new Fetcher(
      accept,
      options && options.headers,
      options && options.proxy
    );
    //file:// URLs are opt-in (disabled by default for security), mirroring rdf-dereference's localFiles option
    if (options && options.localFiles) {
      this.fetcher.localFiles = true;
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

  // Converts quads into a plain JSON-LD {"@graph": [...]} document (named
  // graphs become nested @graph objects keyed by their own @id), with no
  // framing applied yet -- shared by frame() (which frames the result) and
  // messageToJsonLd() (which uses it as-is, unframed, for NDJSON-LD output).
  quadsToJsonLdGraph (triples) {
    var objects = {"@graph": []};
    var graphs = {};
    for (var triple of triples) {
      let subjectURI = triple.subject.value;
      let objectURI = triple.object.value;
      //Json-LD lib uses underscores when blanknode
      if (triple.subject.termType === 'BlankNode') {
        subjectURI = '_:' + triple.subject.value;
      }
      if (triple.object.termType === 'BlankNode') {
        objectURI = '_:' + triple.object.value;
      }

      if (triple.graph.value && !graphs[triple.graph.value]) {
        let graphURI = triple.graph.value;
        if (triple.graph.termType === 'BlankNode') {
          graphURI = '_:' + triple.graph.value;
        }
        graphs[graphURI] = {"@id": graphURI, "@graph" : []};
      }

      var obj = {
        "@id" : subjectURI,
      };
      if (triple.object.termType === 'Literal') {
        obj[triple.predicate.value] = {"@value" : triple.object.value};
        if (triple.object.language) {
          obj[triple.predicate.value]["@language"] = triple.object.language;
        } else if (triple.object.datatype) {
          obj[triple.predicate.value]["@type"] = triple.object.datatype.value;
        }
      } else if (triple.predicate.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type') {
        obj["@type"] = objectURI;
      } else {
        obj[triple.predicate.value] = {"@id": objectURI};
      }
      if (!triple.graph.value) {
        objects["@graph"].push(obj);
      } else {
        let graphURI = triple.graph.value;
        if (triple.graph.termType === 'BlankNode') {
          graphURI = '_:' + triple.graph.value;
        }
        graphs[graphURI]["@graph"].push(obj);
      }
    }
    objects["@graph"].push(...Object.values(graphs));
    return objects;
  }

  async frame (triples, frame) {
    const jsonld = require('jsonld');
    const jsonldframe = jsonld.frame || (jsonld.default && jsonld.default.frame);
    if (typeof jsonldframe !== 'function') {
      throw new Error('Unable to load jsonld.frame');
    }
    if (typeof triples === 'string') {
      triples = await this.get(triples).then(response => {
        return response.triples;
      });
    }
    return jsonldframe(this.quadsToJsonLdGraph(triples), frame);
  }

  // Converts one RDF Message's quads into a JSON-LD "data message" per the
  // NDJSON-LD RDF Message Log format (see
  // https://w3c-cg.github.io/rsp/spec/messages#json-ld): the empty message
  // is the literal {}; a message describing exactly one subject (and no
  // named graph) unwraps to that subject's plain JSON-LD object, matching
  // the spec's own examples; anything else (multiple subjects, or a named
  // graph) keeps the @graph wrapper, since a single flat object can't
  // represent that. No @context is emitted -- object keys are always full
  // predicate IRIs, so every line is self-contained and independently valid
  // regardless of message order (the spec's context messages are an
  // optional compaction this deliberately doesn't need).
  messageToJsonLd (quads) {
    if (!quads.length) return {};
    var graph = this.quadsToJsonLdGraph(quads);
    return graph['@graph'].length === 1 ? graph['@graph'][0] : graph;
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
      var triples = [], messages = [], promise = q.defer();
      //Start from the prefixes registered through addPrefix, then enrich with
      //whatever the source document declares itself (e.g. Turtle/TriG @prefix)
      var prefixes = Object.assign({}, this.prefixes);
      RdfParsers.parse({
        bodyText: response.body,
        bodyBuffer: response.bodyBuffer,
        contentType: response.type,
        baseIRI: response.url,
        requestUrl: url,
        // BrowserHttpFetcher exposes the active transport proxy so nested
        // JSON-LD @context requests follow the same route as this document.
        proxy: this.fetcher._proxy || ''
      })
        .on('prefix', (prefix, iri) => {
          if (!(prefix in prefixes)) {
            prefixes[prefix] = iri;
          }
          this.emit('prefix', prefix, iri);
        })
        .on('data', (quad, messageCounter) => {
          triples.push(quad);
          this.emit('quad', quad, messageCounter);
        })
        //Only fires for RDF Message-framed sources (e.g. "-messages" versioned
        //Turtle/TriG, or Jelly-RDF, which is inherently message-framed)
        .on('message', (quadsInMessage) => {
          messages.push(quadsInMessage);
          this.emit('message', quadsInMessage);
        })
        .on('error', (error) => promise.reject(error))
        .on('end', () => {
          this.emit('parsed', response.url);
          promise.resolve({ triples,
                            prefixes,
                            messages,
                            statusCode: response.statusCode,
                            url: response.url}
                         );
        });
      return promise.promise;
    });
  }

  // Like get(), but never buffers the whole body in memory: quads/messages
  // are only ever handed out live via the 'quad'/'message'/'prefix' events,
  // and the resolved value carries no triples/messages array (see issue
  // #59 -- a multi-GB RDF Message log otherwise has to fully download AND
  // fully parse before a CLI consumer sees anything). Only content types
  // with a genuine incremental parser (Turtle-family, Jelly-RDF) actually
  // stream; anything else is buffered internally from the same already-open
  // connection (no second request) and routed through the ordinary parse(),
  // which alone knows how to sniff compression/extension-based content
  // types from the body bytes -- streaming mode can't, since by the time
  // bytes are available they've already been handed to the parser.
  getStream (url) {
    this.emit('request', url);
    return this.fetcher.getStream(url).then((response) => {
      if (url !== response.url) {
        this.emit('redirect', {'from': url, 'to': response.url});
      }
      this.emit('response', response.url);
      var promise = q.defer();
      var prefixes = Object.assign({}, this.prefixes);

      var wireEmitter = (source) => {
        source
          .on('prefix', (prefix, iri) => {
            if (!(prefix in prefixes)) {
              prefixes[prefix] = iri;
            }
            this.emit('prefix', prefix, iri);
          })
          .on('data', (quad, messageCounter) => this.emit('quad', quad, messageCounter))
          .on('message', (quadsInMessage) => this.emit('message', quadsInMessage))
          .on('error', (error) => promise.reject(error))
          .on('end', () => {
            this.emit('parsed', response.url);
            promise.resolve({ prefixes, statusCode: response.statusCode, url: response.url });
          });
      };

      var resolvedType = RdfParsers.resolveContentType(response.type, response.url, url);
      if (RdfParsers.isStreamable(resolvedType)) {
        wireEmitter(RdfParsers.parseStream(response.stream, { contentType: resolvedType, baseIRI: response.url }));
      } else {
        // No incremental parser for this format (JSON-LD, RDF/XML, HTML,
        // SHACL-C -- none of which support RDF Message framing anyway): buffer
        // the already-open stream ourselves rather than issuing a second
        // request, then hand off to parse(), which can still sniff
        // compression/extension-based content types from the buffered bytes.
        var chunks = [];
        response.stream.on('data', (chunk) => chunks.push(chunk));
        response.stream.on('error', (error) => promise.reject(error));
        response.stream.on('end', () => {
          var bodyBuffer = Buffer.concat(chunks);
          wireEmitter(RdfParsers.parse({
            bodyText: bodyBuffer.toString('utf8'),
            bodyBuffer: bodyBuffer,
            contentType: response.type,
            baseIRI: response.url,
            requestUrl: url,
            proxy: this.fetcher._proxy || ''
          }));
        });
      }
      return promise.promise;
    });
  }
};
