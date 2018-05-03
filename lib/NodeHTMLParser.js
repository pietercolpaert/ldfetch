const {JSDOM} = require("jsdom");
module.exports = function (string, base) {
  return (new JSDOM(string, {url: base})).window.document;
}
