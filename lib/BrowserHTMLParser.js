module.exports = function (string, base) {
  var parser = new DOMParser();
  var doc = parser.parseFromString(string, "text/html");
  doc.URL = base;
  doc.documentURI = base;
  return doc;
}
