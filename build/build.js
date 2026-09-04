#!/usr/bin/env node
const esbuild = require('esbuild');
const path = require('path');

esbuild.build({
  entryPoints: [path.join(__dirname, '..', 'lib', 'ldfetch-browser.js')],
  outfile: path.join(__dirname, '..', 'dist', 'main.js'),
  bundle: true,
  minify: true,
  sourcemap: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  // The Node core modules below have browser polyfills published under
  // different package names; everything else (e.g. url, util) already
  // resolves because the polyfill is published under the same name.
  alias: {
    http: 'stream-http',
    https: 'https-browserify',
    stream: 'stream-browserify',
  },
  // rdf-parse's dependency tree references the `process` and `Buffer`
  // globals without requiring them, which Node provides natively but
  // browsers don't; inject browser-safe shims for both.
  inject: [
    path.join(__dirname, 'process-shim.js'),
    path.join(__dirname, 'buffer-shim.js'),
  ],
  define: {
    global: 'globalThis',
  },
  logLevel: 'info',
}).catch(() => process.exit(1));
