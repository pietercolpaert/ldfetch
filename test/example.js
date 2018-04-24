var ldfetch = require('../lib/ldfetch.js');
var fetch = new ldfetch();
var n3 = require('n3');

/**
 * This example script shows how you can discover all subjects mentioned on the hydra:previous page of a Linked Data resource
 */

var main = async function () {
  try {
    var url = 'https://graph.irail.be/sncb/connections/';
    var options = ""; //{headers: {'Accept-Datetime': '2017-03-11T17:00:00.000Z'}}; // optional -- and then we’d have to look for the next page in a more advanced way
    var fetch = new ldfetch(options);
    fetch.addPrefix("hydra","http://www.w3.org/ns/hydra/core#");
    var response = await fetch.get(url); 
    for (var i = 0; i < response.triples.length; i ++) {
      var triple = response.triples[i];
      if (triple.subject.value === response.url && triple.predicate.value === 'http://www.w3.org/ns/hydra/core#next') {
        console.error('The next page is: ', triple.object.value);
      }
    }
  } catch (e) {
    console.error(e);
  }
}
main();
