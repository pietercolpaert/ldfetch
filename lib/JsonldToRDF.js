const JsonLdParser = require("jsonld-streaming-parser").JsonLdParser;
const Readable = require('stream').Readable;

module.exports = class {

  constructor (options) {
    this.documentIRI = options.documentIRI;
  }

  parse (document, callback) {
    var myParser = new JsonLdParser({baseIRI : this.documentIRI});
    //Create a new stream from the document string
    
    const s = new Readable();
    s._read = () => {};
    s.push(document);
    s.push(null);

    s.pipe(myParser)
      .on('data', (quad) => {
        callback(null, quad);
      })
      .on('error', (error) => {
        callback(error);
      })
      .on('end', () => {
        callback(null, null);
      });
  }
}
