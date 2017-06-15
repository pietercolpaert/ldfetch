var ldfetch = require('../lib/ldfetch.js');

var fetch = new ldfetch();
fetch.addPrefix("hydra","http://www.w3.org/ns/hydra/core#");

//var resourcePromise = fetch.get('https://linked.open.gent/parking');
var resourcePromise = fetch.get('http://graph.spitsgids.be/connections/?departureTime=2017-06-12T11%3A00');
var resourcePromise2 = fetch.get('http://graph.spitsgids.be/connections/?departureTime=2017-06-12T11%3A01');
//var resourcePromise = fetch.get('http://fragments.dbpedia.org/2016-04/en');
//var resourcePromise = fetch.get("http://schema.org/");
//Prefixes to be added to the N3 Store so we can query the data in an easier fashion

var cb = function (response) {
  //Response contains a store and a url
  //var prevpageTriple = response.store.getTriples(response.url,"hydra:previous"); //gets triples about this current page with a predicate hydra:previous
  var prevpageTriple = response.store.getTriples(null,"http://www.w3.org/ns/hydra/core#next"); //gets triples about this current page with a predicate hydra:previous
  console.dir(prevpageTriple);
};

//Execute the request and do something with the response
resourcePromise.then(response => {
  cb(response);
  resourcePromise2.then(cb, (error) => {
    console.error(error);
  });
}, (error) => {
  console.error(error);
});


