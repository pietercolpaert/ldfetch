# Linked Data Fetch: a HTTP client for RDF resources

For both the browser as the NodeJS framework it adds features specifically for getting RDF resources.

Supports small extra building blocks:
 * Prefers to read TriG, but also reads N3, turtle, N-Triples, N-Quads, RDFa or JSON-LD (content-negotiation)
 * Returns an N3 store containing the triples for the current document
 * Emits events for: `request`, `response`, `redirect`, `cache-hit`, `cache-miss` and `parsed`

NodeJS framework in specific
 * Automatically follows redirects
 * Able to be configured with HTTP caching
 * Able to limit the amount of concurrent requests and schedule these

```bash
npm install ldfetch
```

And using browserify you can also compile it for browser purposes:
```bash
browserify lib/ldfetch-browser.js > build.js
```
```html
<script src="build.js"></script>
<script>
  var fetch = new window.ldfetch();
  //use it as described bellow
</script>
```

## How to use it

A small example fetching the previous page of a hydra paged collection and returning its subjects
```javascript
var ldfetch = require('../lib/ldfetch.js'),
    n3 = require('n3');
var fetch = new ldfetch();
fetch.addPrefix("hydra","http://www.w3.org/ns/hydra/core#");
fetch.get(url).then(response => {
  console.error("Redirected to: " + response.url);
  response.store = new n3.Store(response.triples,{prefixes: response.prefixes});
  console.log("Requesting the previous page: " + response.store.getTriples(null,"hydra:previous")[0].object);
  fetch.get(response.store.getTriples(null,"hydra:previous")[0].object).then((response2) => {
    response2.store = new n3.Store(response2.triples,{prefixes: response2.prefixes});
    //return the subjects:
    console.log(response2.store.getSubjects());
  });
});
```

The response object will look like this:
```json
{
  "responseCode": 200,
  "triples": [], //Following the N3.js triple representation
  "prefixes": {"hydra": "http://www.w3.org/ns/hydra/core#"},
  "url": "//url after redirects"
}
```

## What we want you to build

This library was built for the use within hypermedia agents that follow RDF links.

Adding browsing features (although I do not have a concrete use case for this today):
 * Optionally keeps a history which allows you to jump back, forward, or study the list of visited URIs
 * Able to stop loading a request
 * Refresh a page based on HTTP caching headers (max-age and/or poll for eTag changes? Or just ping when the current page is out of date?)

Automatically exploiting Hydra links, such as hydra:next, hydra:previous, hydra:search, hydra:filter, etc. The Linked Data Fragments client for recognizing Triple Pattern Fragment and the Linked Connections client for recognizing an lc: departureTimeQuery

## Architecture

Focuses on two parts:

 1. 2 classes, one for in the browser, and one for in NodeJS (adding caching, redirects and concurrent requests), that take care of the HTTP abstraction
 2. A class using 1. that picks the right parser and parses the data and stores it in a memory structure/store of choice
 
