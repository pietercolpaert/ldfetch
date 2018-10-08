const jsonld = require('jsonld');
const DataFactory = require('@rdfjs/data-model')

module.exports = class {

  constructor (options) {
    this.documentIRI = options.documentIRI;
    this.factory = options.factory || DataFactory;
  }
  
  term (plainTerm) {
    switch (plainTerm.termType) {
      case 'NamedNode':
        return DataFactory.namedNode(plainTerm.value)
      case 'BlankNode':
        return DataFactory.blankNode(plainTerm.value.substr(2))
      case 'Literal':
        return DataFactory.literal(plainTerm.value, plainTerm.language || DataFactory.namedNode(plainTerm.datatype.value))
      case 'DefaultGraph':
        return DataFactory.defaultGraph()
      default:
        throw Error('unknown termType: ' + plainTerm.termType)
    }
  }
  
  addEqualsMethodToQuad (quad) {
    quad.subject = this.term(quad.subject);
    quad.predicate = this.term(quad.predicate);
    quad.object = this.term(quad.object);
    quad.graph = this.term(quad.graph);
    return quad;
  }

  parse (document, callback) {
    jsonld.toRDF(JSON.parse(document), {base: this.documentIRI}, (error, quads) => {
      for (var index in quads) {
        var quad = quads[index];
        
        callback(null, this.addEqualsMethodToQuad(quad));
        if (index == quads.length-1 ) {
          //This is the end
          callback(null, null);
        }
      }
      if (error) {
        callback(error);
      }
    });
  }
}
