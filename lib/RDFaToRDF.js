var RDFaProcessor = require('rdfa-processor').RDFaProcessor;
const DataFactory = require('@rdfjs/data-model')
module.exports = class {

  constructor (options) {
    this.documentIRI = options.documentIRI;
    this.factory = options.factory || DataFactory;
  }
  
  parse (document, callback) {
    try {
      var processor = new RDFaProcessor(null, this.factory);
      processor.onTriple = function (triple) {
        callback(null, triple);
      }
      processor.process(document, {baseURI: this.documentIRI});
    } catch (e) {
      callback(e);
    }

  }
}
