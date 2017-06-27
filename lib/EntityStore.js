module.exports = class {
  constructor (options) {
    this.triples = {};
    this.prefixes = {};
  }

  addTriple (triple) {
    if (triple.graph) {
      if (!this.triples[triple.graph])
        this.triples[triple.graph] = {};
      if (!this.triples[triple.graph][triple.subject]) {
        this.triples[triple.graph][triple.subject] = {};
      }
      this.triples[triple.graph][triple.subject][triple.predicate] = triple.object;
    } else {
      if (!this.triples[triple.subject]) {
        this.triples[triple.subject] = {};
      }
      this.triples[triple.subject][triple.predicate] = triple.object;
    }
  }
  
  addPrefix (prefix, uri) {
    this.prefixes[prefix] = uri;
  }

  addPrefixes (prefixes) {
    prefixes.forEach( (prefix, uri) => {
      this.addPrefix(prefix, uri);
    });
  }
  
  addTriples (triples) {
    triples.forEach(triple => {
      this.addTriple(triple);
    });
  }

  getTriples () {
    return triples;
  }
}
