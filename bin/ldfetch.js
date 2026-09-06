#!/usr/bin/env node
var ldfetch = require('../lib/ldfetch.js');
var isAllowedProtocol = require('../lib/allowedProtocol.js');
var rdfWriter = require('rdf-writer-ts');
var program = require('commander').program;
var path = require('path');
var fs = require('fs');

var url = "";
console.error('LDFetch. Use --help to discover more instructions');

var list = function (val) {
  return val.split(',');
}

program
  .option('-p, --predicates <predicates ...>', 'Some predicates can be followed [predicates]', list)
  .option('--frame <jsonldframe|file>', 'Add a JSON-LD frame')
  .option('-l, --local-files', 'Allow fetching file:// URLs (disabled by default; only use with trusted input)')
  .arguments('<url>')
  .action(function (argUrl) {
    url = argUrl;
  })
  .parse(process.argv);

let options = program.opts();

if (!options.predicates)  options.predicates = [];

var fetch = new ldfetch({ localFiles: !!options.localFiles });

//Prefixes to be added to the writer so we can output the data in an easier fashion
fetch.addPrefix("hydra","http://www.w3.org/ns/hydra/core#");

if (!url) {
  console.error('Provide a URI please');
  process.exit();
}

var history = [url];

if (!isAllowedProtocol(url, { localFiles: options.localFiles })) {
  console.error(options.localFiles
    ? 'Only http://, https:// and file:// URLs are supported'
    : 'Only http:// and https:// URLs are supported (pass --local-files to also allow file:// URLs)');
  process.exit(1);
}
var writer = new rdfWriter.Writer(process.stdout, {end: false});
var prefixesWritten = false;

var processPage = async function (pageUrl) {
  console.error('GET ' + pageUrl);
  var startTime = new Date();
  try {
    var response = await fetch.get(pageUrl);
    var endTime = new Date();
    console.error('' + response.statusCode + ' ' +response.url + ' (' + (endTime.getTime() - startTime.getTime()) + 'ms)');
    history.push(pageUrl);
    history.push(response.url);
    //Prefixes discovered in the source (e.g. Turtle/TriG @prefix, SHACL-C's
    //defaults, Jelly-RDF's namespace table, ...) are only known once the
    //first response has been parsed, so declare them on the writer here
    if (!prefixesWritten) {
      prefixesWritten = true;
      writer.addPrefixes(response.prefixes);
    }
    if (response.triples) {
      if (options.frame) {
        let frame;

        if (fs.existsSync(options.frame)) {
          frame = JSON.parse(fs.readFileSync(options.frame));
        }
        else {
          frame = JSON.parse(options.frame);
        }
        let object = await fetch.frame(response.triples, frame);
        console.log(JSON.stringify(object));
      } else {
        writer.addQuads(response.triples);
      }
    }
    for (let triple of response.triples) {
      if (options.predicates.includes(triple.predicate.value) && !history.includes(triple.object.value) && triple.object.termType === 'NamedNode') {
        try {
          await processPage(triple.object.value);
        } catch (e) {
          console.error('Failed to retrieve ' + pageUrl + ':' + e + ' -- But continuing');
        }
      }
    }
  } catch (e) {
    console.error('Failed to retrieve ' + pageUrl + ': ' + e);
  }
}


processPage(url).then(() => {
  writer.end();
  console.log(""); //newline at end of stdout
});

