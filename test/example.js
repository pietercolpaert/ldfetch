var ldfetch = require('../lib/ldfetch.js');
var fetch = new ldfetch();
var n3 = require('n3');

/**
 * This example script shows how you can discover all subjects mentioned on the hydra:previous page of a Linked Data resource
 */

var main = async function () {
  try {
    let url = 'https://graph.irail.be/sncb/connections/';
    let fetch = new ldfetch({}); //options: allow to add more headers if needed
    let response = await fetch.get(url);
    for (let i = 0; i < response.triples.length; i ++) {
      let triple = response.triples[i];
      if (triple.subject.value === response.url && triple.predicate.value === 'http://www.w3.org/ns/hydra/core#next') {
        console.error('The next page is: ', triple.object.value);
      }
    }
    fetch.frame(url, {'http://www.w3.org/ns/hydra/core#next': {}}).then(object => {
      console.error('Or you can also use the JSON-LD frame functionality to get what you want in a JS object', object);
    });
  } catch (e) {
    console.error(e);
  }
}
main();

