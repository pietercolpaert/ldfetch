var RDFaProcessor = require('rdfa-processor').RDFaProcessor;

const { DataFactory } = require('n3');
const { namedNode, blankNode, literal, defaultGraph, quad } = DataFactory;
module.exports = class {

  constructor (options) {
    this.documentIRI = options.documentIRI;
  }
  
  parse (document, callback) {
    try {
      var processor = new RDFaProcessor();
      processor.onTriple = function (triple) {
        callback(null, triple);
      }
      processor.process(document, {baseURI: this.documentIRI});
    } catch (e) {
      callback(e);
    }

  }
}
