var jsonld = require('jsonld');
var jsonldRdfaParser = require('jsonld-rdfa-parser');
const { DataFactory } = require('n3');
const { namedNode, blankNode, literal, defaultGraph, quad } = DataFactory;
module.exports = class {

  constructor (options) {
    jsonld.registerRDFParser('text/html', jsonldRdfaParser);
    this.documentIRI = options.documentIRI;
  }

  addEqualsMethodToQuad (quad) {
    quad.equals = DataFactory.internal.Quad.prototype.equals;
    if (quad.subject.termType === 'NamedNode')
      quad.subject.equals = DataFactory.internal.NamedNode.prototype.equals;
    if (quad.subject.termType === 'BlankNode')
      quad.subject.equals = DataFactory.internal.BlankNode.prototype.equals;
    if (quad.predicate.termType === 'NamedNode')
      quad.predicate.equals = DataFactory.internal.NamedNode.prototype.equals;
    if (quad.predicate.termType === 'BlankNode')
      quad.predicate.equals = DataFactory.internal.BlankNode.prototype.equals;
    if (quad.object.termType === 'NamedNode')
      quad.object.equals = DataFactory.internal.NamedNode.prototype.equals;
    if (quad.object.termType === 'BlankNode')
      quad.object.equals = DataFactory.internal.BlankNode.prototype.equals;
    if (quad.object.termType === 'Literal')
      quad.object.equals = DataFactory.internal.Literal.prototype.equals;
    if (quad.graph.termType === 'NamedNode')
      quad.graph.equals = DataFactory.internal.NamedNode.prototype.equals;
    if (quad.graph.termType === 'BlankNode')
      quad.graph.equals = DataFactory.internal.BlankNode.prototype.equals;
    if (quad.graph.termType === 'DefaultGraph')
      quad.graph.equals = DataFactory.internal.DefaultGraph.prototype.equals;
    return quad;
  }
  
  parse (document, callback) {
    jsonld.fromRDF(document, {format: 'text/html', base: this.documentIRI}, (err, data) => {
      if (!data || data.length === 0 || err) {
        callback();
      } else {
        //read context
        jsonld.toRDF(data, (error, quads) => {
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
    });    
  }
}
