const NodePolyfillPlugin = require("node-polyfill-webpack-plugin")

module.exports = {
  entry: './lib/ldfetch-browser.js',
  // Other rules...
  plugins: [
    new NodePolyfillPlugin()
  ]
  //  mode: 'development'
}
