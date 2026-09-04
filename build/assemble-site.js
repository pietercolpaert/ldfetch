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
  ['dist/main.js', 'main.js'],
  ['dist/main.js.map', 'main.js.map'],
  ['dist/playground.js', 'playground.js'],
  ['dist/playground.js.map', 'playground.js.map'],
];

for (const [from, to] of files) {
  fs.copyFileSync(path.join(root, from), path.join(siteDir, to));
}

console.log('Assembled site in ' + siteDir);
