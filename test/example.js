var ldfetch = require('../lib/ldfetch.js');

/**
 * This example script shows how you can discover all subjects mentioned on the hydra:previous page of a Linked Data resource
 */

var main = async function () {
  console.log('This is an example program');
  try {
    let url = 'https://graph.irail.be/sncb/connections';
    let fetcher = new ldfetch({}); //options: allows to add more headers if needed
    let response = await fetcher.get(url);
    for (let i = 0; i < response.triples.length; i ++) {
      let triple = response.triples[i];
      if (triple.subject.value === response.url && triple.predicate.value === 'http://www.w3.org/ns/hydra/core#next') {
        console.error('The next page is: ', triple.object.value);
      }
    }
  } catch (e) {
    console.error(e);
  }
}

main();

