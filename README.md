# Linked Data Fetch: a HTTP client for RDF resources

[![npm version](https://badge.fury.io/js/ldfetch.svg)](https://badge.fury.io/js/ldfetch) [![CDN JSDelivr](https://data.jsdelivr.com/v1/package/npm/ldfetch/badge)](https://cdn.jsdelivr.net/npm/ldfetch/dist/main.js)

Fetch Linked Data documents within your browser, from the command line, or from your NodeJS script.

```bash
npm install -g ldfetch
```
In order to use it as a library, you can leave out the `-g`.

## Features

Supports these features over standard `fetch`:
 * Sets an accept header for negotiating an RDF serialization
 * Parses a wide variety of RDF serializations, each through its own dedicated streaming parser: [rdf-parser-ts](https://github.com/pietercolpaert/rdf-parser.ts) (Turtle, TriG, N-Triples, N-Quads, RDF 1.2, RDF Message Logs) by Pieter Colpaert, [jsonld-streaming-parser](https://github.com/rubensworks/streaming-jsonld-parser.js), [rdfa-streaming-parser](https://github.com/rubensworks/rdfa-streaming-parser.js) and [microdata-rdf-streaming-parser](https://github.com/rubensworks/microdata-rdf-streaming-parser.js) (all three run together and merged for HTML, so a page's RDFa attributes, Microdata attributes, and any embedded `<script type="application/ld+json">` blocks all contribute triples), and [rdfxml-streaming-parser](https://github.com/rdfjs/rdfxml-streaming-parser.js), all by Ruben Taelman, [shaclc-parse](https://github.com/jeswr/shaclcjs) by Jesse Wright for SHACL Compact syntax, and [rdfjs-jelly](https://github.com/pietercolpaert/rdfjs-jelly) for the compact binary [Jelly-RDF](https://jelly-rdf.github.io/) format (requires Node.js >=24; lazily loaded, so older Node versions are unaffected unless you actually fetch Jelly-RDF content)
 * Returns the Triples/Quads containing the data in the [RDFJS triple representation](http://rdf.js.org/)
 * Returns the URL of the document after redirects
 * Returns and streams any prefixes/namespaces declared by the source document (Turtle/TriG, SHACL Compact syntax, Jelly-RDF), in addition to any registered with `addPrefix`
 * Groups RDF Message-framed sources (Turtle/TriG "-messages" versions, and Jelly-RDF, which is inherently message-framed) into `response.messages`, and emits a `message` event per message as it's parsed -- progressively, as each message completes, not only once the whole source has been read
 * Emits events for: `request`, `response`, `redirect`, `cache-hit`, `cache-miss`, `quad`, `prefix`, `message` and `parsed` -- `quad` fires per parsed triple, so you can consume results as they stream in instead of waiting for the whole document

Try it live in the [playground](https://www.pieter.pm/ldfetch/), which fetches and streams any Linked Data document straight in your browser, with optional JSON-LD framing.

Features for the NodeJS framework in specific:
 * Automatically follows redirects
 * Able to be configured with HTTP caching
 * Able to limit the amount of concurrent requests and schedule these

Features for the Command Line:
 * Writes data on any URL in TriG on stdout by default; pass `--format nquads` or `--format json-ld` for N-Quads or JSON-LD instead
 * Streams that output as the source is being downloaded and parsed, rather than waiting for the whole thing -- so a multi-gigabyte RDF Message log starts printing triples immediately instead of after a full download (formats without an incremental parser -- JSON-LD, RDF/XML, HTML, SHACL Compact -- are still buffered internally; `--frame`, `--predicates` and `--format json-ld` also require the whole response and fall back to buffering)
 * Round-trips an RDF Message-framed source (see Features above) as a proper RDF Message Log: `--format trig`/`nquads` keep the `VERSION`/`MESSAGE` (or `@version`/`@message`) delimiters, including empty messages; `--format json-ld` instead writes [newline-delimited JSON-LD](https://w3c-cg.github.io/rsp/spec/messages#json-ld) (NDJSON-LD), one JSON object per message, with `{}` for an empty one
 * Extra features to automatically follow links (see `ldfetch --help` after `npm install -g ldfetch`)

## How to use it

### Command line

![Quite easy](https://raw.githubusercontent.com/pietercolpaert/ldfetch/master/tty.gif "Straightforward to use this on a CLI")

You can also use [JSON-LD framing](https://json-ld.org/spec/latest/json-ld-framing/) from the CLI: `ldfetch https://pietercolpaert.be/ --frame {}` to return a JSON-LD object complying to your frame. This applies to the whole graph as one document, so it always buffers, regardless of `--format` or RDF Message framing.

By default, only `http://` and `https://` URLs are fetched. Pass `--local-files` to also allow `file://` URLs, e.g. `ldfetch --local-files file:///path/to/data.ttl` (disabled by default for security; only use with trusted input).

For full, well tested and modular SPARQL or GraphQL Web Querying, we refer to the [Comunica project](http://comunica.linkeddatafragments.org).

### Browser

And using esbuild you can compile it for browser purposes:
```bash
npm run build
```

```html
<script src="dist/main.js"></script>
<script>
  let fetcher = new window.ldfetch();
  let main = async function () {
    let objects = await fetcher.get('https://staging.api.irail.be/graph/').then(response => {
      //LDFetch also exposes a frame function that can be used on the triples
      //See https://json-ld.org/spec/latest/json-ld-framing/
      return fetcher.frame(response.triples, {'@graph':{}});
    });
    console.log(objects);
  }
  try {
    main();
  } catch (e) {
    console.error(e);
  }
</script>
```

### NodeJS

A small example fetching the next page of a paged collection and returning the url
```javascript
  let ldfetch = require('../lib/ldfetch.js');
  try {
    let url = 'https://staging.api.irail.be/graph/';
    let fetch = new ldfetch({}); //options: allow to add more headers if needed
    let response = await fetch.get(url); 
    for (let i = 0; i < response.triples.length; i ++) {
      let triple = response.triples[i];
      if (triple.subject.value === response.url && triple.predicate.value === 'http://www.w3.org/ns/hydra/core#next') {
        console.error('The next page is: ', triple.object.value);
      }
    }
    fetch.frame(response.triples, {'http://www.w3.org/ns/hydra/core#next': {}}).then(object => {
      console.error('Or you can also use the JSON-LD frame functionality to get what you want in a JS object', object);
    });
  } catch (e) {
    console.error(e);
  }
```
  
If HTTP requests with specific headers are needed, the `options` object may be used by defining an object inside of it, named `headers` containing HTTP header names and values.

The response object will look like this:
```json
{
  "responseCode": 200,
  "triples": [{},{},{}],
  "prefixes": {"foaf": "http://xmlns.com/foaf/0.1/"},
  "messages": [],
  "url": "https://{url after redirects}"
}
```
`prefixes` merges what you registered with `addPrefix` and whatever the source document declares itself. `messages` is only populated for RDF Message-framed sources (see Features above) -- each entry is the array of quads belonging to one message.

#### Streaming large sources with `getStream`

For sources too large to hold in memory (the CLI uses this internally, see Features above), `getStream` never accumulates `triples`/`messages` at all -- consume `quad`/`message`/`prefix` events on the fetcher as they arrive instead:

```javascript
let fetch = new ldfetch({});
fetch.on('quad', quad => console.log(quad));
fetch.on('message', quadsInMessage => console.log('message with', quadsInMessage.length, 'quads'));
let response = await fetch.getStream('https://example.org/huge-rdf-message-log.nt');
console.log('done, saw prefixes:', response.prefixes);
```

Only content types with a genuine incremental parser (Turtle, TriG, N-Triples, N-Quads and Jelly-RDF) actually stream this way; anything else (JSON-LD, RDF/XML, HTML, SHACL Compact) is buffered internally from the same connection and parsed as usual, still without a `triples`/`messages` array in the resolved response -- only available in the Node.js version, not in the browser bundle.

For a message-framed source, every `quad` event also carries the RDF Message it belongs to as a second argument (`undefined` for an ordinary quad): `fetch.on('quad', (quad, messageCounter) => { ... })`. This is what lets a consumer write RDF Message Log-shaped output quad by quad instead of waiting for a whole message: [rdf-writer-ts](https://github.com/pietercolpaert/rdf-writer.ts)'s `writer.addQuad({ quad, messageCounter })` form writes the `VERSION`/`MESSAGE` delimiters itself, filling in empty messages from gaps in the counter, exactly like the CLI's default output does.

`messageToJsonLd(quads)` converts one RDF Message's quads into a JSON-LD "data message" per the [NDJSON-LD RDF Message Log format](https://w3c-cg.github.io/rsp/spec/messages#json-ld) -- the empty message becomes `{}`, a single-subject message unwraps to that subject's plain object, and anything else keeps the `@graph` wrapper:

```javascript
fetch.on('message', quadsInMessage => console.log(JSON.stringify(fetch.messageToJsonLd(quadsInMessage))));
```

## License and copyright

This library was developed by [Pieter Colpaert](https://pietercolpaert.be) and contributors. The source code is available under an MIT license.
