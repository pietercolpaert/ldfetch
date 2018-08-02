#!/usr/bin/env node
var ldfetch = require('../lib/ldfetch.js');
var fetch = new ldfetch();
var n3 = require('n3');
var program = require('commander');

var url = "";
console.error('LDFetch. Use --help to discover more instructions');

var list = function (val) {
  return val.split(',');
}

program
  .option('-p, --predicates <predicates ...>', 'Some predicates can be followed [predicates]', list)
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
var writer = n3.Writer(process.stdout, {end: false});

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
      writer.addQuads(response.triples);
    }
    for (var i in response.triples) {
      var triple = response.triples[i];
      if (program.predicates.includes(triple.predicate.value) && !history.includes(triple.object.value) && triple.object.termType === 'NamedNode') {
        await processPage(triple.object.value);
      }
    }
  } catch (e) {
    console.error('Failed to retrieve ' + pageUrl + ': ' + e);
  }
}


processPage(url).then(()=> {
  writer.end();
  console.log(""); //newline at end of stdout
});

