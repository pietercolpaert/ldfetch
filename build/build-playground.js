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

// CSV on the Web support (rdf-parser-csvw, csv-parse and luxon) is only
// loaded once a CSVW metadata document is shown, as window.ldfetchCsvw
esbuild.build({
  ...browserPolyfills,
  alias: { ...browserPolyfills.alias, 'node:url': 'url' },
  entryPoints: [path.join(__dirname, '..', 'playground', 'csvw.mjs')],
  outfile: path.join(__dirname, '..', 'dist', 'csvw.js'),
  globalName: 'ldfetchCsvw',
}).catch(() => process.exit(1));
