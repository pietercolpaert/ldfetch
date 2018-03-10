var ldfetch = require('../lib/ldfetch.js');
var fetch = new ldfetch();
var n3 = require('n3');

/**
 * This example script shows how you can discover all subjects mentioned on the hydra:previous page of a Linked Data resource
 */

var main = async function () {
  try {
    //Prefixes to be added to the N3 Store so we can query the data in an easier fashion
    fetch.addPrefix("hydra","http://www.w3.org/ns/hydra/core#");

    //var url1 = 'http://linked.open.gent/parking';
    //but works as well flawlessly with this:
    //var url1 = 'https://graph.irail.be/sncb/connections/';
    
    var url1 = 'https://pietercolpaert.be';

    //Execute the request and do something with the response
    console.log("Requesting url1: " + url1);
    fetch.on('redirect', urlObj => {
      console.log(urlObj.from + ' redirected to ' + urlObj.to);
    });
    
    var response = await fetch.get(url1);
    console.log(response.triples);
    response.store = new n3.Store(response.triples,{prefixes: response.prefixes});
    console.log("Requesting the previous page: " + response.store.getTriples(null,"hydra:previous")[0].object);
    var response2 = await fetch.get(response.store.getTriples(null,"hydra:previous")[0].object);

    response2.store = new n3.Store(response.triples,{prefixes: response.prefixes});
    console.log("final url that was requested: " + response2.url);
    //just return the subjects:
    console.log(response2.store.getSubjects());
  } catch (e) {
    console.error(e);
  }
}
main();
