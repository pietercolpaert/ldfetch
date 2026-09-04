#!/usr/bin/env node
const esbuild = require('esbuild');
const path = require('path');
const browserPolyfills = require('./browser-polyfills.js');

// Bundled separately from dist/main.js: the playground loads main.js first
// (the same bundle a real consumer would use) and this script afterwards,
// so it only needs to add rdf-writer-ts and the UI wiring on top.
esbuild.build({
  ...browserPolyfills,
  entryPoints: [path.join(__dirname, '..', 'playground', 'app.js')],
  outfile: path.join(__dirname, '..', 'dist', 'playground.js'),
}).catch(() => process.exit(1));
