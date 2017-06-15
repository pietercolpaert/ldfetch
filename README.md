# Linked Data Fetch: a HTTP client for RDF resources

For both the browser as the NodeJS framework it adds features specifically for getting RDF resources.

Supports small extra building blocks:
 * Prefers to read TriG, but also reads N3, turtle, N-Triples, JSON-LD or N-Quads (content-negotiation)
 * Returns an N3 store containing the triples for the current document

NodeJS framework in specific
 * Automatically follows redirects
 * Able to be configured with HTTP caching
 * Able to limit the amount of concurrent requests and schedule these

```bash
npm install ldfetch
```

## What we want you to build

This library was built for the use within hypermedia agents that follow RDF links.

Adding browsing features (although I do not have a concrete use case for this today):
 * Optionally keeps a history which allows you to jump back, forward, or study the list of visited URIs
 * Able to stop loading a request
 * Refresh a page based on HTTP caching headers (max-age and/or poll for e-tag changes? Or just ping when the current page is out of date?)

Automatically exploiting Hydra links, such as hydra:next, hydra:previous, hydra:search, hydra:filter, etc. The Linked Data Fragments client for recognizing Triple Pattern Fragment and the Linked Connections client for recognizing an lc: departureTimeQuery

## Architecture

Focuses on two parts:

 1. 2 classes, one for in the browser, and one for in NodeJS (adding caching, redirects and concurrent requests), that take care of the HTTP abstraction
 2. A class using 1. that picks the right parser and parses the data and stores it in an N3 store
 
