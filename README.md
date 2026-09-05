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
 * Parses a wide variety of RDF serializations, each through its own dedicated streaming parser: [rdf-parser-ts](https://github.com/pietercolpaert/rdf-parser.ts) (Turtle, TriG, N-Triples, N-Quads, RDF 1.2, RDF Message Logs) by Pieter Colpaert, [jsonld-streaming-parser](https://github.com/rubensworks/streaming-jsonld-parser.js), [rdfa-streaming-parser](https://github.com/rubensworks/rdfa-streaming-parser.js) and [microdata-rdf-streaming-parser](https://github.com/rubensworks/microdata-rdf-streaming-parser.js) (both used together for HTML), and [rdfxml-streaming-parser](https://github.com/rdfjs/rdfxml-streaming-parser.js), all by Ruben Taelman, [shaclc-parse](https://github.com/jeswr/shaclcjs) by Jesse Wright for SHACL Compact syntax, and [rdfjs-jelly](https://github.com/pietercolpaert/rdfjs-jelly) for the compact binary [Jelly-RDF](https://jelly-rdf.github.io/) format (requires Node.js >=24; lazily loaded, so older Node versions are unaffected unless you actually fetch Jelly-RDF content)
 * Returns the Triples/Quads containing the data in the [RDFJS triple representation](http://rdf.js.org/)
 * Returns the URL of the document after redirects
 * Returns and streams any prefixes/namespaces declared by the source document (Turtle/TriG, SHACL Compact syntax, Jelly-RDF), in addition to any registered with `addPrefix`
 * Groups RDF Message-framed sources (Turtle/TriG "-messages" versions, and Jelly-RDF, which is inherently message-framed) into `response.messages`, and emits a `message` event per message as it's parsed
 * Emits events for: `request`, `response`, `redirect`, `cache-hit`, `cache-miss`, `quad`, `prefix`, `message` and `parsed` -- `quad` fires per parsed triple, so you can consume results as they stream in instead of waiting for the whole document

Try it live in the [playground](https://www.pieter.pm/ldfetch/), which fetches and streams any Linked Data document straight in your browser, with optional JSON-LD framing.

Features for the NodeJS framework in specific:
 * Automatically follows redirects
 * Able to be configured with HTTP caching
 * Able to limit the amount of concurrent requests and schedule these

Features for the Command Line:
 * Writes data on any URL in TriG on stdout
 * Extra features to automatically follow links (see `ldfetch --help` after `npm install -g ldfetch`)

## How to use it

### Command line

![Quite easy](https://raw.githubusercontent.com/pietercolpaert/ldfetch/master/tty.gif "Straightforward to use this on a CLI")

You can also use [JSON-LD framing](https://json-ld.org/spec/latest/json-ld-framing/) from the CLI: `ldfetch https://pietercolpaert.be/ --frame {}` to return a JSON-LD object complying to your frame.

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

## License and copyright

This library was developed by [Pieter Colpaert](https://pietercolpaert.be) and contributors. The source code is available under an MIT license.
