# HTTP client for RDF resources

For both the browser as the NodeJS framework.

Supports small extra building blocks:
 * Prefers to read TriG, but also reads N3, turtle, N-Triples, JSON-LD or N-Quads
 * Returns an N3 store containing the triples for the current document

NodeJS framework in specific
 * Able to follow redirects
 * Able to be configured with HTTP caching
 * Able to limit the amount of concurrent requests and schedule these


## Wishlist

Adds browsing features (although I do not have a concrete use case for this today):
 * Optionally keeps a history which allows you to jump back, forward, or study the list of visited URIs
 * Able to stop loading a request
 * Refresh a page based on HTTP caching headers (max-age and/or poll for e-tag changes? Or just ping when the current page is out of date?)
 
