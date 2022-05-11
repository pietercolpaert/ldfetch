#!/usr/bin/env node
var ldfetch = require('../lib/ldfetch.js');
var fetch = new ldfetch();
var n3 = require('n3');
var program = require('commander');
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
  .arguments('<url>')
  .action(function (argUrl) {
    //TODO: check whether starts with http(s)?
    url = argUrl;
  })
  .parse(process.argv);

if (!program.predicates)  program.predicates = [];

//Prefixes to be added to the N3 Store so we can query the data in an easier fashion
fetch.addPrefix("hydra","http://www.w3.org/ns/hydra/core#");

if (!process.argv[2]) {
  console.error('Provide a URI please');
  process.exit();
}

var history = [url];

var url = process.argv[2];
var writer = new n3.Writer(process.stdout, {end: false});

var processPage = async function (pageUrl) {
  console.error('GET ' + pageUrl);
  var startTime = new Date();
  try {
    var response = await fetch.get(pageUrl);
    var endTime = new Date();
    console.error('' + response.statusCode + ' ' +response.url + ' (' + (endTime.getTime() - startTime.getTime()) + 'ms)');
    history.push(pageUrl);
    history.push(response.url);
    if (response.triples) {
      if (program.frame) {
        let frame;

        if (fs.existsSync(program.frame)) {
          frame = JSON.parse(fs.readFileSync(program.frame));
        }
        else {
          frame = JSON.parse(program.frame);
        }

        let object = await fetch.frame(response.triples, frame);
        console.log(JSON.stringify(object));
      } else {
        writer.addQuads(response.triples);
      }
    }
    for (var i in response.triples) {
      var triple = response.triples[i];
      if (program.predicates.includes(triple.predicate.value) && !history.includes(triple.object.value) && triple.object.termType === 'NamedNode') {
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

