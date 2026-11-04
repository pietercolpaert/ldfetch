#!/usr/bin/env node
const esbuild = require('esbuild');
const path = require('path');
const browserPolyfills = require('./browser-polyfills.js');

esbuild.build({
  ...browserPolyfills,
  // Not shipped in the npm package: only the playground site uses the map
  sourcemap: 'external',
  entryPoints: [path.join(__dirname, '..', 'lib', 'ldfetch-browser.js')],
  outfile: path.join(__dirname, '..', 'dist', 'main.js'),
}).catch(() => process.exit(1));
