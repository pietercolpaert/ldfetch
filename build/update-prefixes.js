#!/usr/bin/env node
// Compiles prefix.cc's popular prefixes into lib/prefix-cc.json: a
// namespace IRI -> prefix label table, in prefix.cc's popularity order. The
// CLI and the playground use it to declare a well-known prefix for a
// namespace the source itself did not declare one for (see
// lib/PrefixedWriter.js). The library bundle (dist/main.js) never loads it.
const fs = require('fs');
const path = require('path');

const SOURCE = 'http://prefix.cc/popular/all.file.csv';
const OUTPUT = path.join(__dirname, '..', 'lib', 'prefix-cc.json');

// Namespaces used throughout ldfetch's examples that prefix.cc has no
// prefix for, or only one we would not choose (it votes `sc` for
// https://schema.org/). These take precedence over prefix.cc's entries.
const PREFERRED = {
  'https://schema.org/': 'schema',
  'https://w3id.org/tss#': 'tss',
  'https://w3id.org/conn#': 'conn'
};

// Only labels the Turtle writer can declare as-is
const VALID_LABEL = /^[A-Za-z][A-Za-z0-9_-]*$/;

async function main () {
  const response = await fetch(SOURCE);
  if (!response.ok) throw new Error('GET ' + SOURCE + ': HTTP ' + response.status);
  const csv = await response.text();
  const table = Object.assign({}, PREFERRED);
  for (const line of csv.split(/\r?\n/)) {
    const match = /^([^,]+),"([^"]+)"$/.exec(line.trim());
    if (!match) continue;
    const [, label, namespace] = match;
    // The most popular prefix for a namespace comes first, so keep that one
    if (!VALID_LABEL.test(label) || !/^[a-z][a-z0-9+.-]*:/i.test(namespace) || namespace in table) continue;
    table[namespace] = label;
  }
  fs.writeFileSync(OUTPUT, JSON.stringify(table, null, 0).replace(/","/g, '",\n"') + '\n');
  console.log('Wrote ' + Object.keys(table).length + ' prefixes to ' + path.relative(process.cwd(), OUTPUT));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
