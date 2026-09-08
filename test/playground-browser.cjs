// Run after npm run build:site. Uses the installed Chromium and localhost only
// for fixtures; the map's OpenStreetMap tiles use the normal public service.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer-core');

(async () => {
  const root = path.resolve(__dirname, '../_site');
  const { Writer, DataFactory } = require('rdfjs-jelly');
  const { namedNode, literal, quad } = DataFactory;
  const jelly = await new Promise((resolve, reject) => {
    const writer = new Writer({ namespaces: { ex: 'https://example.org/' } });
    for (let i = 0; i < 1002; i++) writer.addMessage(Array.from({ length: 10 }, (_, j) =>
      quad(namedNode('https://example.org/s' + i), namedNode('https://example.org/p' + j), literal('Jelly value ' + i))));
    writer.end((error, bytes) => error ? reject(error) : resolve(require('node:zlib').gzipSync(bytes)));
  });
  const singleJelly = await new Promise((resolve, reject) => {
    const writer = new Writer({ namespaces: { ex: 'https://example.org/' } });
    writer.addMessage([quad(namedNode('https://example.org/single'), namedNode('https://schema.org/name'), literal('One Jelly message'))]);
    writer.end((error, bytes) => error ? reject(error) : resolve(bytes));
  });
  const flatMessages = require('node:zlib').gzipSync('VERSION "1.1-messages"\n' + Array.from({ length: 1002 }, (_, i) =>
    '<https://example.org/observation/' + i + '> <https://example.org/value> "' + i + '" .\nMESSAGE\n'
  ).join(''));
  const ordinaryGzip = require('node:zlib').gzipSync('<https://example.org/ordinary> <https://schema.org/name> "Ordinary compressed RDF" .');
  let proxiedAccept;
  let contextWasProxied = false;
  let riverbenchJellyWasProxied = false;
  let riverbenchFlatWasProxied = false;
  let riverbenchStreamingAccept;
  let ordinaryGzipRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/prefixes.trig') {
      res.setHeader('Content-Type', 'application/trig');
      res.end('VERSION "1.2-messages"\nPREFIX schema: <http://schema.org/>\nPREFIX custom: <https://example.org/custom/>\ncustom:alice schema:name "Alice" .');
      return;
    }
    if (req.url === '/data.jelly.gz') {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.end(process.env.JELLY_FIXTURE ? fs.readFileSync(process.env.JELLY_FIXTURE) : jelly);
      return;
    }
    if (req.url === '/single.jelly') {
      res.setHeader('Content-Type', 'application/x-jelly-rdf');
      res.end(singleJelly);
      return;
    }
    if (req.url === '/header-messages.trig') {
      res.setHeader('Content-Type', 'application/trig; version="1.2-messages"');
      res.end('<https://example.org/first> <https://schema.org/name> "First" .\nMESSAGE\n<https://example.org/second> <https://schema.org/name> "Second" .');
      return;
    }
    if (req.url === '/large.trig') {
      res.setHeader('Content-Type', 'application/trig');
      res.end('VERSION "1.2-messages"\nPREFIX geo: <http://www.opengis.net/ont/geosparql#>\n' + Array.from({ length: 1002 }, (_, i) => '<https://example.org/repeated> geo:asWKT "POINT (' + (i % 170) + ' 20)"^^geo:wktLiteral .').join('\nMESSAGE\n'));
      return;
    }
    if (req.url === '/ordinary.nt.gz') {
      ordinaryGzipRequests++;
      res.setHeader('Content-Type', 'application/octet-stream');
      res.end(ordinaryGzip);
      return;
    }
    if (req.url === '/ldes.ttl') {
      res.setHeader('Content-Type', 'text/turtle');
      res.end('@prefix ldes: <https://w3id.org/ldes#>. @prefix tree: <https://w3id.org/tree#>. @prefix hydra: <http://www.w3.org/ns/hydra/core#>. @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>. @prefix xsd: <http://www.w3.org/2001/XMLSchema#>. <http://127.0.0.1:' + server.address().port + '/ldes.ttl#stream> a ldes:EventStream; tree:view <http://127.0.0.1:' + server.address().port + '/ldes.ttl#page>. <http://127.0.0.1:' + server.address().port + '/ldes.ttl#page> hydra:search [ hydra:template "http://127.0.0.1:' + server.address().port + '/search{?subject,predicate,object}"; hydra:mapping [ hydra:variable "subject"; hydra:property rdf:subject ], [ hydra:variable "predicate"; hydra:property rdf:predicate ], [ hydra:variable "object"; hydra:property rdf:object ] ]; tree:relation [ a tree:GreaterThanOrEqualToRelation; tree:path <https://example.org/time>; tree:value "2026-01-01"^^xsd:date; tree:node <http://127.0.0.1:' + server.address().port + '/next.ttl> ].');
      return;
    }
    if (req.url.startsWith('/search?')) {
      res.setHeader('Content-Type', 'text/turtle');
      res.end('<https://example.org/search-result> <http://www.w3.org/2000/01/rdf-schema#label> "Hydra search result".');
      return;
    }
    if (req.url === '/next.ttl') {
      res.setHeader('Content-Type', 'text/turtle');
      res.end('<https://example.org/member> <http://www.w3.org/2000/01/rdf-schema#label> "Loaded next page".');
      return;
    }
    if (req.url.startsWith('/proxy/http://') && req.url.endsWith('/proxied.ttl')) {
      proxiedAccept = req.headers.accept;
      res.setHeader('Content-Type', 'text/turtle');
      res.end('<#resource> <https://schema.org/name> "Fetched through proxy".');
      return;
    }
    if (req.url.startsWith('/proxy/http://') && req.url.endsWith('/proxied.jsonld')) {
      res.setHeader('Content-Type', 'application/ld+json');
      res.end(JSON.stringify({ '@context': 'http://contexts.example/context.jsonld', '@id': '#resource', 'schema:name': 'Context fetched through proxy' }));
      return;
    }
    if (req.url === '/proxy/http://contexts.example/context.jsonld') {
      contextWasProxied = true;
      res.setHeader('Content-Type', 'application/ld+json');
      res.end(JSON.stringify({ '@context': { schema: 'https://schema.org/' } }));
      return;
    }
    if (req.url === '/proxy/https://w3id.org/riverbench/datasets/assist-iot-weather/dev/files/jelly_full.jelly.gz') {
      riverbenchJellyWasProxied = true;
      riverbenchStreamingAccept = req.headers.accept;
      res.setHeader('Content-Type', 'application/octet-stream');
      res.end(jelly);
      return;
    }
    if (req.url === '/proxy/https://w3id.org/riverbench/datasets/assist-iot-weather/dev/files/flat_full.nt.gz') {
      riverbenchFlatWasProxied = true;
      res.setHeader('Content-Type', 'application/octet-stream');
      res.end(flatMessages);
      return;
    }
    if (req.url === '/blank-nodes.ttl') {
      res.setHeader('Content-Type', 'text/turtle');
      res.end('@prefix geo: <http://www.opengis.net/ont/geosparql#>. @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#>. @prefix ex: <https://example.org/>. ex:feature rdfs:label "Named blank-node geometry"; ex:address [ ex:street "Main Street" ]; geo:hasGeometry _:geometry. _:geometry geo:asWKT "POINT (4 50)"^^geo:wktLiteral. ex:first ex:place _:ambiguous. ex:second ex:place _:ambiguous. _:ambiguous geo:asWKT "POINT (5 51)"^^geo:wktLiteral.');
      return;
    }
    const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    const target = file === root + '/' ? path.join(root, 'index.html') : file;
    const ext = path.extname(target);
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.trig': 'application/trig', '.ttl': 'text/turtle', '.jsonld': 'application/ld+json', '.svg': 'image/svg+xml' })[ext] || 'application/octet-stream');
    fs.readFile(target, (error, content) => { if (error) { res.statusCode = 404; res.end(); } else res.end(content); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath: process.env.CHROMIUM_PATH || '/snap/bin/chromium', headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const base = 'http://127.0.0.1:' + server.address().port + '/';
    await page.goto(base + '#url=' + encodeURIComponent(base + 'examples/geospatial-messages.trig'));
    await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Done'));
    assert.equal(await page.$eval('#proxy-toggle', el => el.checked), false);
    assert.equal(await page.$eval('#proxy-url', el => el.value), 'https://proxy.linkeddatafragments.org/');
    assert.equal(await page.$eval('#proxy-url-field', el => el.hidden), true);
    assert.equal(page.url().includes('proxy='), false);
    assert.equal(await page.$$eval('#examples-list > .example-chip', nodes => nodes.length), 3, 'Only a minimal set of examples stays visible');
    assert.deepEqual(await page.$$eval('#examples-list > .example-chip', nodes => nodes.map(node => node.textContent)), ['Wikidata', 'Pieter Colpaert', 'Ghent Altarpiece']);
    await page.click('#more-examples > summary');
    assert.ok(await page.$$eval('.example-menu h3', nodes => nodes.map(node => node.textContent).includes('Hypermedia controls')));
    assert.deepEqual(await page.$$eval('.example-menu section', sections => {
      const identity = sections.find(section => section.querySelector('h3')?.textContent === 'Identity');
      return Array.from(identity.querySelectorAll('.example-chip'), button => button.textContent);
    }), ['Pieter Heyvaert', 'Ruben Verborgh', 'Patrick Hochstenbach', 'ORCID researcher']);
    assert.ok(await page.$('[data-example="mol-ldes"]'));
    assert.ok(await page.$('[data-example="riverbench-weather"]'));
    await page.click('#more-examples > summary');
    await page.waitForFunction(() => document.querySelector('#explore-tab').textContent === 'Explore (1)');
    assert.equal(await page.$eval('#triples-pane', el => el.hidden), false);
    assert.equal(await page.$eval('#visualization-workbench', el => el.hidden), true);
    assert.equal(await page.$eval('#explore-tab', el => el.textContent), 'Explore (1)');
    assert.ok(await page.$eval('#message-editor', el => el.textContent.includes('POINT')));
    assert.equal(await page.evaluate(() => !!window.maplibregl), false, 'Globe is lazy loaded');
    await page.click('#explore-tab');
    assert.equal(await page.$eval('[data-view-tabs] > button:last-child', el => el.dataset.view), 'overview');
    assert.equal(await page.$('[data-more-views] [data-view="overview"]'), null);
    await page.waitForFunction(() => document.querySelector('[data-globe]')?._globe?.getSource('features'), { timeout: 30000 });
    const first = await page.evaluate(async () => {
      const map = document.querySelector('[data-globe]')._globe;
      return { projection: map.getProjection().type, features: (await map.getSource('features').getData()).features.length };
    });
    assert.equal(first.projection, 'globe');
    assert.equal(first.features, 3);
    await page.click('[data-geometry-id="0"]');
    await page.waitForFunction(() => {
      const map = document.querySelector('[data-globe]')?._globe;
      if (!map) return false;
      const center = map.getCenter();
      return Math.abs(center.lng - 4.35) < 0.02 && Math.abs(center.lat - 50.85) < 0.02 && map.getZoom() >= 11.5;
    });
    assert.ok(await page.$eval('.feature-popup', el => el.textContent.includes('Brussels') && el.textContent.includes('rdfs:label')));
    assert.deepEqual(await page.$$eval('.feature-popup dt', nodes => nodes.map(node => node.textContent).filter(name => ['Geometry', 'Message', 'CRS'].includes(name))), []);
    assert.equal(await page.$eval('.feature-popup h3 a', el => el.href), 'https://example.org/globe/brussels');
    await page.goto(base + '#url=' + encodeURIComponent(base + 'blank-nodes.ttl') + '&pane=explore&view=map');
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('/blank-nodes.ttl'));
    await page.waitForSelector('.geometry-list');
    assert.equal(await page.$eval('.geometry-list button', el => el.textContent), 'Named blank-node geometry');
    assert.ok(await page.$eval('.geometry-list', el => el.textContent.includes('_:ambiguous')));
    assert.equal(await page.$$eval('#visualization-workbench [data-entity^="BlankNode|"], #visualization-workbench [data-select-entity^="BlankNode|"]', nodes => nodes.length), 0);
    await page.evaluate(() => document.querySelector('.geometry-list button').click());
    await page.waitForSelector('[data-entity-details] [data-blank-toggle]');
    assert.equal(await page.$eval('[data-entity-details] .blank-node-properties', el => el.hidden), true);
    await page.click('[data-entity-details] [data-blank-toggle]');
    assert.equal(await page.$eval('[data-entity-details] .blank-node-properties', el => el.hidden), false);
    assert.ok(await page.$eval('[data-entity-details] .blank-node-properties', el => el.textContent.includes('Main Street')));
    await page.goto(base + '#url=' + encodeURIComponent(base + 'examples/geospatial-messages.trig'));
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('geospatial-messages.trig'));
    await page.click('#explore-tab');
    await page.waitForFunction(() => document.querySelector('[data-globe]')?._globe?.getSource('features'), { timeout: 30000 });
    await page.evaluate(() => { window.originalGlobe = document.querySelector('[data-globe]')._globe; });
    await page.screenshot({ path: '/tmp/ldfetch-globe.png', fullPage: true });
    await page.select('#message-scope', 'memory');
    await page.waitForFunction(() => document.querySelector('.geometry-list h3')?.textContent.includes('7 geometries'));
    await page.waitForFunction(() => document.querySelector('[data-globe]')?._globe?.getSource('features'));
    assert.equal(await page.evaluate(() => window.originalGlobe === document.querySelector('[data-globe]')._globe), true, 'Scope updates preserve the interactive globe');
    assert.ok((await page.url()).includes('scope=memory'));
    await page.reload();
    await page.waitForFunction(() => document.querySelector('.geometry-list h3')?.textContent.includes('7 geometries'));
    assert.equal(await page.$eval('#triples-pane', el => el.hidden), true);
    await page.goto(base + '#url=' + encodeURIComponent(base + 'examples/visualization-showcase.ttl'));
    await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Done'));
    await page.click('#explore-tab');
    assert.ok(await page.$('[data-more-views] [data-view="images"]'));
    assert.equal(await page.$('[data-view-tabs] [data-view="images"]'), null);
    assert.ok((await page.$eval('[data-view="iiif"]', el => el.textContent)).includes('IIIF Presentation'));
    await page.evaluate(() => document.querySelector('[data-view="iiif"]').click());
    await page.waitForSelector('.canvas-image img');
    assert.equal(await page.$eval('[data-view-language]', select => select.value), 'en');
    assert.ok(await page.$eval('.presentation-heading', heading => heading.textContent.includes('Example image presentation')));
    await page.select('[data-view-language]', 'nl');
    assert.ok(await page.$eval('.presentation-heading', heading => heading.textContent.includes('Voorbeeldpresentatie')));
    assert.ok(page.url().includes('lang=nl'));
    await page.select('[data-view-language]', 'en');
    assert.ok(await page.$eval('.canvas-image img', image => image.src.endsWith('/examples/avatar-alice.svg')));
    assert.ok(await page.$eval('.canvas-strip figcaption', caption => caption.textContent.includes('1 annotation')));
    await page.evaluate(() => document.querySelector('[data-iiif-canvas]').click());
    await page.waitForSelector('.iiif-dialog[open]');
    assert.equal(await page.$$eval('.iiif-dialog .iiif-region', regions => regions.length), 1);
    assert.ok(await page.$eval('.iiif-detail-annotations', element => element.textContent.includes('Alice’s portrait')));
    await page.click('[data-iiif-close]');
    await page.goto(base + '#url=' + encodeURIComponent(base + 'examples/mol-tss-readings.trig') + '&pane=explore&view=timeseries');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('mol-tss-readings.trig'));
    await page.waitForSelector('.time-series-point[data-point-id="stage-1215"]');
    assert.equal(await page.$eval('.time-series-point[data-point-id="stage-1215"]', el => el.dataset.value), '29.66');
    assert.ok(await page.$eval('.time-series-point[data-point-id="stage-1215"] title', el => el.textContent.includes('2020-11-07T12:15:00')));
    await page.click('#more-examples > summary');
    await page.click('[data-example="riverbench-weather"]');
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('riverbench-weather-sample.trig'));
    await page.waitForSelector('.time-series-point');
    assert.equal(await page.$eval('#message-scope', el => el.value), 'memory');
    assert.ok(page.url().includes('scope=memory'));
    assert.ok(await page.$eval('.time-series-list', el => el.textContent.includes('air-temperature')));
    await page.goto(base + '#url=' + encodeURIComponent(base + 'ldes.ttl') + '&pane=explore&view=hypermedia');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('/ldes.ttl'));
    assert.ok(await page.$eval('.relation-controls', el => el.textContent.includes('2026-01-01')));
    await page.waitForSelector('.hydra-search-form input[name="subject"]');
    await page.type('.hydra-search-form input[name="subject"]', '<https://example.org/Alice>');
    await page.type('.hydra-search-form input[name="object"]', 'Alice Smith');
    await page.evaluate(() => document.querySelector('.hydra-search-form').requestSubmit());
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('/search?subject='));
    assert.equal(await page.$eval('#url', el => el.value), base + 'search?subject=%3Chttps%3A%2F%2Fexample.org%2FAlice%3E&object=Alice%20Smith');
    assert.ok(page.url().includes(encodeURIComponent('/search?subject=')));
    await page.setViewport({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.goto(base + '#url=' + encodeURIComponent(base + 'large.trig') + '&pane=explore&view=map&scope=window');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Paused'));
    await page.waitForFunction(() => document.querySelector('.geometry-list h3')?.textContent.includes('1000 geometries'), { timeout: 60000 });
    await page.select('#message-scope', 'memory');
    await page.waitForFunction(() => document.querySelector('.geometry-list h3')?.textContent.includes('1000 geometries'));
    assert.equal(await page.$eval('#message-editor .CodeMirror', el => (el.CodeMirror.getValue().match(/POINT/g) || []).length), 1, 'Explore scope does not expand the selected-message output');
    await page.click('#load-more-messages');
    await page.waitForFunction(() => document.querySelector('.geometry-list h3')?.textContent.startsWith('2 geometries'));
    assert.ok((await page.$eval('[data-scope-status]', el => el.textContent)).includes('1001–1002'));
    await page.goto(base + '#url=' + encodeURIComponent(base + 'prefixes.trig') + '&pane=explore&view=profile');
    await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Done'));
    await page.waitForSelector('.dataset-profile-grid');
    assert.equal(await page.$eval('[data-view-tabs] > button:last-child', el => el.dataset.view), 'overview');
    assert.ok(await page.$eval('#prefixes-list', el => el.textContent.includes('schema: https://schema.org/')));
    assert.ok(await page.$eval('#prefixes-list', el => el.textContent.includes('schema2: http://schema.org/')));
    assert.ok(await page.$eval('#prefixes-list', el => el.textContent.includes('custom: https://example.org/custom/')));
    assert.equal(await page.$eval('#messages-panel', el => el.hidden), true);
    assert.ok(await page.$eval('#output-editor .CodeMirror', el => el.CodeMirror.getValue().includes('schema2:name')));
    await page.goto(base + '#url=' + encodeURIComponent(base + 'data.jelly.gz'));
    await page.waitForFunction(() => /^(Paused|Done)/.test(document.querySelector('#status').textContent), { timeout: 60000 });
    assert.equal(await page.$eval('#output-editor .CodeMirror', el => el.CodeMirror.getValue()), '', 'No hidden whole-log editor for Jelly');
    assert.ok(await page.$eval('#message-editor .CodeMirror', el => el.CodeMirror.getValue().length > 0));
    assert.ok(await page.$eval('#prefixes-list', el => el.textContent.includes('http://www.w3.org/1999/02/22-rdf-syntax-ns#')));
    if (!process.env.JELLY_FIXTURE) {
      assert.ok(await page.$eval('#prefixes-list', el => el.textContent.includes('https://example.org/')));
      assert.ok(await page.$eval('#status', el => el.textContent.includes('1002 messages fetched so far')));
    }
    console.log('Jelly regression:', await page.$eval('#status', el => el.textContent));
    await page.click('#load-more-messages');
    assert.ok(await page.$eval('#message-position', el => el.textContent.startsWith('message 1001 ')));
    await page.select('#message-scope', 'memory');
    await page.evaluate(() => { document.querySelector('#advanced').open = true; });
    await page.select('#output-format', 'jsonld');
    assert.ok(await page.$eval('#message-editor .CodeMirror', el => JSON.parse(el.CodeMirror.getValue())), 'JSON-LD remains one object with all-memory Explore scope');
    assert.ok(page.url().includes('format=jsonld'));
    await page.evaluate(() => document.querySelector('#frame-editor .CodeMirror').CodeMirror.setValue('{"@graph":{}}'));
    await page.click('#frame-toggle');
    await page.waitForFunction(() => document.querySelector('#message-editor .CodeMirror').CodeMirror.getValue().startsWith('{'));
    assert.ok(await page.$eval('#message-editor .CodeMirror', el => JSON.parse(el.CodeMirror.getValue())));
    assert.equal(await page.$eval('#output-editor .CodeMirror', el => el.CodeMirror.getValue()), '', 'JSON-LD framing only renders the selected scope');
    await page.evaluate((proxy, url) => {
      const proxyToggle = document.querySelector('#proxy-toggle');
      const proxyInput = document.querySelector('#proxy-url');
      proxyToggle.checked = true;
      proxyToggle.dispatchEvent(new Event('change', { bubbles: true }));
      proxyInput.value = proxy;
      proxyInput.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#url').value = url;
      document.querySelector('#url-form').requestSubmit();
    }, base + 'proxy/', base + 'proxied.ttl');
    await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Done'));
    assert.ok(await page.$eval('#output-editor .CodeMirror', el => el.CodeMirror.getValue().includes('Fetched through proxy')));
    assert.match(proxiedAccept, /^application\/n-quads/);
    assert.equal(proxiedAccept.includes('jelly'), false);
    assert.ok(page.url().includes('proxy=' + encodeURIComponent(base + 'proxy/')));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Done'));
    assert.equal(await page.$eval('#proxy-toggle', el => el.checked), true);
    assert.equal(await page.$eval('#proxy-url-field', el => el.hidden), false);
    assert.equal(await page.$eval('#proxy-url', el => el.value), base + 'proxy/');
    await page.evaluate(url => {
      document.querySelector('#url').value = url;
      document.querySelector('#url-form').requestSubmit();
    }, base + 'proxied.jsonld');
    await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Done'));
    assert.equal(contextWasProxied, true);
    const riverbenchJellyUrl = 'https://w3id.org/riverbench/datasets/assist-iot-weather/dev/files/jelly_full.jelly.gz';
    await page.goto(base + '#url=' + encodeURIComponent(riverbenchJellyUrl) + '&proxy=' + encodeURIComponent(base + 'proxy/'));
    await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Paused'));
    assert.equal(riverbenchJellyWasProxied, true);
    assert.match(riverbenchStreamingAccept, /^application\/n-quads/);
    assert.ok(await page.$eval('#status', el => Number((el.textContent.match(/(\d+) messages fetched so far/) || [])[1]) >= 1000));
    assert.equal(await page.$eval('#message-slider', el => el.max), '999');
    const riverbenchFlatUrl = 'https://w3id.org/riverbench/datasets/assist-iot-weather/dev/files/flat_full.nt.gz';
    await page.goto(base + '#url=' + encodeURIComponent(riverbenchFlatUrl) + '&proxy=' + encodeURIComponent(base + 'proxy/'));
    await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Paused'));
    assert.equal(riverbenchFlatWasProxied, true);
    assert.ok(await page.$eval('#status', el => Number((el.textContent.match(/(\d+) messages fetched so far/) || [])[1]) >= 1000));
    assert.equal(await page.$eval('#message-slider', el => el.max), '999');
    await page.goto(base + '#url=' + encodeURIComponent(base + 'ordinary.nt.gz'));
    await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Done'));
    assert.equal(ordinaryGzipRequests, 1, 'Ordinary RDF stays on the same streaming request');
    assert.equal(await page.$eval('#messages-panel', el => el.hidden), true);
    assert.ok(await page.$eval('#output-editor .CodeMirror', el => el.CodeMirror.getValue().includes('Ordinary compressed RDF')));
    await page.goto(base + '#url=' + encodeURIComponent(base + 'single.jelly'));
    await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Done'));
    assert.equal(await page.$eval('#messages-panel', el => el.hidden), true);
    assert.ok(await page.$eval('#output-editor .CodeMirror', el => el.CodeMirror.getValue().includes('One Jelly message')));
    await page.goto(base + '#url=' + encodeURIComponent(base + 'header-messages.trig'));
    await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Done'));
    assert.equal(await page.$eval('#messages-panel', el => el.hidden), false);
    assert.equal(await page.$eval('#message-slider', el => el.max), '1');
    assert.deepEqual(errors, []);
    console.log('Browser checks passed: default triples, ranking, Overview, prefixes, Jelly, lazy globe, geometries, message scope, share restoration, mobile layout.');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
