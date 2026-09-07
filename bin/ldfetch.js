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

var FORMATS = ['trig', 'nquads', 'json-ld'];

program
  .option('-p, --predicates <predicates ...>', 'Some predicates can be followed [predicates]', list)
  .option('--frame <jsonldframe|file>', 'Add a JSON-LD frame')
  .option('--format <trig|nquads|json-ld>', 'Output format (default: trig)', 'trig')
  .option('-l, --local-files', 'Allow fetching file:// URLs (disabled by default; only use with trusted input)')
  .arguments('<url>')
  .action(function (argUrl) {
    url = argUrl;
  })
  .parse(process.argv);

let options = program.opts();

if (!options.predicates)  options.predicates = [];

if (FORMATS.indexOf(options.format) === -1) {
  console.error('Unknown --format ' + options.format + ' (expected one of: ' + FORMATS.join(', ') + ')');
  process.exit(1);
}

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
//RDF Message-framed sources (Turtle/TriG "-messages" versions, Jelly-RDF)
//round-trip as RDF Message Logs here too: rdf-writer-ts's addQuad() accepts
//a { quad, messageCounter } entry in place of a bare quad and, given those,
//writes the VERSION/MESSAGE (or @version/@message) delimiters itself --
//including filling in entirely empty messages from gaps in the counter --
//so passing the tagged form whenever it's available (see the 'quad' event,
//and lib/RdfParsers.js's relayMessageAwareStream/wireJellyMessages) is all
//that's needed. Ordinary, non-message sources are untouched: messageCounter
//is simply undefined for their quads, so they fall through to plain addQuad().
var isJsonLd = options.format === 'json-ld';
var writer = new rdfWriter.Writer(process.stdout, { format: options.format === 'nquads' ? 'N-Quads' : 'TriG', end: false });
var prefixesWritten = false;

//--frame needs the whole graph in memory to frame it, --predicates needs
//every triple of a page available up front to decide what to follow next,
//and JSON-LD output needs a complete message (or, absent messages, the
//whole graph) before it can be converted -- all fundamentally incompatible
//with streaming, so only stream plain TriG/N-Quads output with neither of
//those requested. This is what actually solves issue #59: previously every
//fetch, streamed or not, waited for the full body to download AND parse
//before a single triple reached stdout.
var canStream = !options.frame && options.predicates.length === 0 && !isJsonLd;

var processPage = async function (pageUrl) {
  console.error('GET ' + pageUrl);
  var startTime = new Date();
  try {
    if (canStream) {
      //Prefixes are declared on the writer live, as the 'prefix' event
      //fires -- Turtle/TriG's own grammar guarantees a prefix is always
      //declared in the source before its first use, and parsing preserves
      //that order, so writing it out immediately (rather than waiting for
      //the whole document, as the buffered path below does) still produces
      //valid, and still nicely compacted, output.
      var onPrefix = (prefix, iri) => writer.addPrefix(prefix, iri);
      var onQuad = (quad, messageCounter) => {
        if (messageCounter === undefined) writer.addQuad(quad);
        else writer.addQuad({ quad, messageCounter });
      };
      if (!prefixesWritten) {
        prefixesWritten = true;
        writer.addPrefixes(fetch.prefixes);
      }
      fetch.on('prefix', onPrefix);
      fetch.on('quad', onQuad);
      try {
        var response = await fetch.getStream(pageUrl);
      } finally {
        fetch.removeListener('prefix', onPrefix);
        fetch.removeListener('quad', onQuad);
      }
      var endTime = new Date();
      console.error('' + response.statusCode + ' ' + response.url + ' (' + (endTime.getTime() - startTime.getTime()) + 'ms)');
    } else {
      var response = await fetch.get(pageUrl);
      var endTime = new Date();
      console.error('' + response.statusCode + ' ' +response.url + ' (' + (endTime.getTime() - startTime.getTime()) + 'ms)');
      history.push(pageUrl);
      history.push(response.url);
      if (response.triples) {
        if (options.frame) {
          //Frame output is JSON, not Turtle -- the writer (and its prefix
          //header) is only for the Turtle/TriG/N-Quads output path below.
          let frame;

          if (fs.existsSync(options.frame)) {
            frame = JSON.parse(fs.readFileSync(options.frame));
          }
          else {
            frame = JSON.parse(options.frame);
          }
          let object = await fetch.frame(response.triples, frame);
          console.log(JSON.stringify(object));
        } else if (isJsonLd) {
          //Newline-delimited JSON-LD, one line per RDF Message, per
          //https://w3c-cg.github.io/rsp/spec/messages#json-ld -- only
          //meaningful for a message-framed source; otherwise (no messages
          //at all) there's just the one JSON-LD document for the whole graph.
          if (response.messages.length) {
            response.messages.forEach(function (message) {
              console.log(JSON.stringify(fetch.messageToJsonLd(message)));
            });
          } else {
            console.log(JSON.stringify(fetch.quadsToJsonLdGraph(response.triples)));
          }
        } else {
          //Prefixes discovered in the source (e.g. Turtle/TriG @prefix,
          //SHACL-C's defaults, Jelly-RDF's namespace table, ...) are only
          //known once the first response has been parsed, so declare them
          //on the writer here
          if (!prefixesWritten) {
            prefixesWritten = true;
            writer.addPrefixes(response.prefixes);
          }
          //A message-framed source (see the comment above canStream) writes
          //as a proper RDF Message Log the same way the streaming path
          //above does, just one whole message at a time instead of quad by
          //quad, since all of it is already sitting in memory here anyway.
          if (response.messages.length) {
            response.messages.forEach(function (message) { writer.addMessage(message); });
          } else {
            writer.addQuads(response.triples);
          }
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
    }
  } catch (e) {
    console.error('Failed to retrieve ' + pageUrl + ': ' + e);
  }
}


processPage(url).then(() => {
  writer.end();
  console.log(""); //newline at end of stdout
});

