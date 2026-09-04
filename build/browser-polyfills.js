const path = require('path');

// Node core modules referenced by ldfetch's dependency tree that have
// browser polyfills published under a different package name. Modules
// like `url` and `util` are omitted because their polyfills are published
// under the same name, so esbuild resolves them via normal node_modules
// lookup without needing an alias.
const alias = {
  http: 'stream-http',
  https: 'https-browserify',
  stream: 'stream-browserify',
};

// rdf-parse's (Comunica) dependency tree references the `process` and
// `Buffer` globals without requiring them, which Node provides natively
// but browsers don't. Inject browser-safe shims for both.
const inject = [
  path.join(__dirname, 'process-shim.js'),
  path.join(__dirname, 'buffer-shim.js'),
];

module.exports = {
  bundle: true,
  minify: true,
  sourcemap: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  alias,
  inject,
  define: {
    global: 'globalThis',
  },
  logLevel: 'info',
};
