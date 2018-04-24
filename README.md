# Linked Data Fetch: a HTTP client for RDF resources

For both the browser as the NodeJS framework it adds features specifically for getting RDF resources.

Supports these features over standard `fetch`:
 * Prefers to read TriG, yet also reads N3, Turtle, N-Triples, N-Quads, RDFa, JSON-LD snippets hidden in the HTML or just plain JSON-LD (uses content-negotiation to get an RDF representation)
 * Returns the Triples/Quads containing the data in the [RDFJS triple representation](http://rdf.js.org/)
 * Returns the URL of the document after redirects
 * Emits events for: `request`, `response`, `redirect`, `cache-hit`, `cache-miss` and `parsed`

Features for the NodeJS framework in specific:
 * Automatically follows redirects
 * Able to be configured with HTTP caching
 * Able to limit the amount of concurrent requests and schedule these

Features for the Command Line:
 * Writes data on any URL in TriG on stdout
 * Extra features to automatically follow links (see `ldfetch --help` after `npm install -g ldfetch`)

Install it in your project:

```bash
npm install ldfetch
```

And using webpack you can also compile it for browser purposes:
```bash
npm run build
```

```html
<script src="dist/main.js"></script>
<script>
  var fetch = new window.ldfetch();
  //use it as described bellow
</script>
```

## How to use it

A small example fetching the next page of a paged collection and returning the url
```javascript
  var ldfetch = require('../lib/ldfetch.js');
  try {
    var url = 'https://graph.irail.be/sncb/connections/';
    var options = ""; //{headers: {'Accept-Datetime': '2017-03-11T17:00:00.000Z'}}; // optional -- and then we’d have to look for the next page in a more advanced way
    var fetch = new ldfetch(options);
    fetch.addPrefix("hydra","http://www.w3.org/ns/hydra/core#");
    var response = await fetch.get(url); 
    for (var i = 0; i < response.triples.length; i ++) {
      var triple = response.triples[i];
      if (triple.subject.value === response.url && triple.predicate.value === 'http://www.w3.org/ns/hydra/core#next') {
        console.error('The next page is: ', triple.object.value);
      }
    }
  } catch (e) {
    console.error(e);
  }
  ```
  
If HTTP requests with specific headers are needed, the `options` object may be used by defining an object inside of it, named `headers` containig HTTP header names and values.

The response object will look like this:
```json
{
  "responseCode": 200,
  "triples": [{},{},{}],
  "prefixes": {"hydra": "http://www.w3.org/ns/hydra/core#"},
  "url": "https://{url after redirects}"
}
```

## License and copyright

This library was developed by [Pieter Colpaert](https://pietercolpaert.be) and contributors. The source code is available under an MIT license.
