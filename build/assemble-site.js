#!/usr/bin/env node
// Assembles the static playground site into _site/, exactly as it gets
// deployed to GitHub Pages. Used by both CI and `npm run serve:playground`,
// so local testing and the deployed site never drift apart.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const siteDir = path.join(root, '_site');

fs.rmSync(siteDir, { recursive: true, force: true });
fs.mkdirSync(siteDir, { recursive: true });

const files = [
  ['playground/index.html', 'index.html'],
  ['playground/style.css', 'style.css'],
  ['playground/favicon.svg', 'favicon.svg'],
  ['playground/globe-loader.mjs', 'globe-loader.mjs'],
  ['playground/mermaid-loader.mjs', 'mermaid-loader.mjs'],
  ['node_modules/mermaid/dist/mermaid.esm.min.mjs', 'mermaid/mermaid.esm.min.mjs'],
  ['node_modules/mermaid/LICENSE', 'mermaid/LICENSE'],
  ['node_modules/maplibre-gl/dist/maplibre-gl.mjs', 'maplibre-gl.mjs'],
  ['node_modules/maplibre-gl/dist/maplibre-gl-shared.mjs', 'maplibre-gl-shared.mjs'],
  ['node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs', 'maplibre-gl-worker.mjs'],
  ['node_modules/maplibre-gl/dist/maplibre-gl.css', 'maplibre-gl.css'],
  ['node_modules/maplibre-gl/LICENSE.txt', 'maplibre-LICENSE.txt'],
  ['dist/main.js', 'main.js'],
  ['dist/main.js.map', 'main.js.map'],
  ['dist/playground.js', 'playground.js'],
  ['dist/playground.js.map', 'playground.js.map'],
];

for (const [from, to] of files) {
  fs.mkdirSync(path.dirname(path.join(siteDir, to)), { recursive: true });
  fs.copyFileSync(path.join(root, from), path.join(siteDir, to));
}

// Mermaid's ES module build loads the code for each kind of diagram on
// demand from these chunks (source maps left out: they are ~20 MB)
const mermaidChunks = path.join(root, 'node_modules', 'mermaid', 'dist', 'chunks', 'mermaid.esm.min');
const mermaidChunksDest = path.join(siteDir, 'mermaid', 'chunks', 'mermaid.esm.min');
fs.mkdirSync(mermaidChunksDest, { recursive: true });
for (const name of fs.readdirSync(mermaidChunks)) {
  if (name.endsWith('.mjs')) fs.copyFileSync(path.join(mermaidChunks, name), path.join(mermaidChunksDest, name));
}

const examplesSrc = path.join(root, 'playground', 'examples');
const examplesDest = path.join(siteDir, 'examples');
fs.mkdirSync(examplesDest, { recursive: true });
for (const name of fs.readdirSync(examplesSrc)) {
  fs.copyFileSync(path.join(examplesSrc, name), path.join(examplesDest, name));
}

console.log('Assembled site in ' + siteDir);
