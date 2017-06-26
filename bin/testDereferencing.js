var ldfetch = require('../lib/ldfetch.js');
var fetch = new ldfetch();

/**
 * This script will retrieve all subjects from a certain URL and will check for dereferenceability
 * Dereferenceability levels:
 *  1. Does not return a user error (>400), server error (>500) or resolving error
 *  2. Gives an RDF response
 *  3. RDF response contains the URI
 *  4. All URIs in the representation also dereference
 */

//Prefixes to be added to the N3 Store so we can query the data in an easier fashion
fetch.addPrefix("hydra","http://www.w3.org/ns/hydra/core#");

if (!process.argv[2]) {
  console.error('Provide a URI please');
  process.exit();
}

var url1 = process.argv[2];
//but works as well flawlessly with this:
//var url1 = 'http://graph.spitsgids.be/'
//var url1 = 'https://linked.open.gent/parking/?time=2017-06-23T09:52:01';

//Execute the requestand do something with the response

var checkUrl = function (url) {
  var errors = [];
  return fetch.get(url).then(response => {
    var redirUrl = response.url;
    if (response.statusCode !== 200) {
      errors.push(url + ' returns a ' + response.statusCode);
    } else {
      //Check whether the requested URL is used in the page
      if (!response.store.getTriples(url).length > 0) {
        errors.push(url + ' cannot be found in its representation');
      }
      //Check whether the redirected URL is used in the page when redirected
      if (redirUrl !== url &&
          !(response.store.getTriples(redirUrl).length > 0 ||
            response.store.getTriples(null, redirUrl).length > 0 ||
            response.store.getTriples(null, null, redirUrl).length > 0 ||
            response.store.getTriples(null, null, null, redirUrl).length > 0 
           )) {
        errors.push("Redirected " + redirUrl + ' cannot be found in its representation');
      }
    }
    return {
      errors: errors,
      statusCode: response.statusCode,
      url : response.url,
      store: response.store
    };
  }, error => {
    console.error(url, 'ERROR: ' + error);
  });
};

var getNextPage = function (response) {
  var nextPage = response.store.getTriples(response.url, "hydra:next");
  if (nextPage[0]) {
    return nextPage[0].object;
  } else {
    return null;
  }
};

var checkPage = function (response, nextPageCallback) {
  //Now try to request all the subjects and apply the same system.
  var uris = response.store.getSubjects();
  uris = uris.concat(response.store.getPredicates());
  uris = uris.concat(response.store.getObjects());
  uris = uris.concat(response.store.getGraphs());
  uris.forEach((uri, index) => {
    if (uri.substr(0,4) === 'http') {
      checkUrl(uri).then(response2 => {
        if (response2.errors.length > 0) {
          console.error('Errors when requesting ' + uri);
          console.error(response2.errors);
        } else {
          console.error(uri + " validated");
        }
      });
    }
  });
  if (getNextPage(response2)) {
    checkPage(getNextPage(response2));
  }
};

checkUrl(url1).then(response => {
  if (response.errors.length > 0) {
    console.error(response.errors);
  } else {
    //console.error(url1 + " validated");
  }
  checkPage(response);
}, error => {
  console.error(url1, 'ERROR: ' + error);
});


