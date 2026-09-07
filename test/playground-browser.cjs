// Run after npm run build:site. Uses the installed Chromium and localhost only
// for fixtures; the map's OpenStreetMap tiles use the normal public service.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer-core');

(async () => {
  const root = path.resolve(__dirname, '../_site');
  const server = http.createServer((req, res) => {
    if (req.url === '/large.trig') {
      res.setHeader('Content-Type', 'application/trig');
      res.end('VERSION "1.2-messages"\nPREFIX geo: <http://www.opengis.net/ont/geosparql#>\n' + Array.from({ length: 1002 }, (_, i) => '<https://example.org/repeated> geo:asWKT "POINT (' + (i % 170) + ' 20)"^^geo:wktLiteral .').join('\nMESSAGE\n'));
      return;
    }
    const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    const target = file === root + '/' ? path.join(root, 'index.html') : file;
    const ext = path.extname(target);
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.trig': 'application/trig', '.ttl': 'text/turtle', '.svg': 'image/svg+xml' })[ext] || 'application/octet-stream');
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
    await page.waitForFunction(() => document.querySelector('#explore-tab').textContent === 'Explore (1)');
    assert.equal(await page.$eval('#triples-pane', el => el.hidden), false);
    assert.equal(await page.$eval('#visualization-workbench', el => el.hidden), true);
    assert.equal(await page.$eval('#explore-tab', el => el.textContent), 'Explore (1)');
    assert.ok(await page.$eval('#message-editor', el => el.textContent.includes('POINT')));
    assert.equal(await page.evaluate(() => !!window.maplibregl), false, 'Globe is lazy loaded');
    await page.click('#explore-tab');
    await page.waitForFunction(() => document.querySelector('[data-globe]')?._globe?.getSource('features'), { timeout: 30000 });
    const first = await page.evaluate(async () => {
      const map = document.querySelector('[data-globe]')._globe;
      return { projection: map.getProjection().type, features: (await map.getSource('features').getData()).features.length };
    });
    assert.equal(first.projection, 'globe');
    assert.equal(first.features, 3);
    await page.evaluate(() => { window.originalGlobe = document.querySelector('[data-globe]')._globe; });
    await page.screenshot({ path: '/tmp/ldfetch-globe.png', fullPage: true });
    await page.select('#message-scope', 'memory');
    await page.waitForFunction(() => document.querySelector('.geometry-list h3')?.textContent.includes('6 geometries'));
    await page.waitForFunction(() => document.querySelector('[data-globe]')?._globe?.getSource('features'));
    assert.equal(await page.evaluate(() => window.originalGlobe === document.querySelector('[data-globe]')._globe), true, 'Scope updates preserve the interactive globe');
    assert.ok((await page.url()).includes('scope=memory'));
    await page.reload();
    await page.waitForFunction(() => document.querySelector('.geometry-list h3')?.textContent.includes('6 geometries'));
    assert.equal(await page.$eval('#triples-pane', el => el.hidden), true);
    await page.goto(base + '#url=' + encodeURIComponent(base + 'examples/visualization-showcase.ttl'));
    await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Done'));
    await page.click('#explore-tab');
    assert.ok(await page.$('[data-more-views] [data-view="images"]'));
    assert.equal(await page.$('[data-view-tabs] [data-view="images"]'), null);
    assert.ok((await page.$eval('[data-view="iiif"]', el => el.textContent)).includes('IIIF Presentation'));
    await page.setViewport({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.goto(base + '#url=' + encodeURIComponent(base + 'large.trig') + '&pane=explore&view=map&scope=window');
    await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Done'));
    await page.waitForFunction(() => document.querySelector('.geometry-list h3')?.textContent.includes('1000 geometries'));
    await page.select('#message-scope', 'memory');
    await page.waitForFunction(() => document.querySelector('.geometry-list h3')?.textContent.includes('1002 geometries'));
    await page.click('#load-more-messages');
    await page.waitForFunction(() => document.querySelector('.geometry-list h3')?.textContent.startsWith('2 geometries'));
    assert.ok((await page.$eval('[data-scope-status]', el => el.textContent)).includes('1001–1002'));
    assert.deepEqual(errors, []);
    console.log('Browser checks passed: default triples, ranking, lazy globe, geometries, message scope, share restoration, mobile layout.');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
