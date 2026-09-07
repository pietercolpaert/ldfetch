'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const BIN = path.join(__dirname, '..', 'bin', 'ldfetch.js');
const FIXTURE_URL = pathToFileURL(path.join(__dirname, 'fixtures', 'example.ttl')).toString();

function createServer(handler) {
  const server = http.createServer(handler);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${server.address().port}`
      });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close(error => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function runCli(args) {
  return new Promise(resolve => {
    execFile('node', [BIN, ...args], (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

test('CLI fetches and parses an http:// URL', async () => {
  const { server, baseUrl } = await createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/turtle' });
    res.end('<https://example.org/alice> <http://xmlns.com/foaf/0.1/name> "Alice" .');
  });

  try {
    const { code, stdout } = await runCli([`${baseUrl}/resource`]);
    assert.equal(code, 0);
    assert.match(stdout, /Alice/);
  } finally {
    await closeServer(server);
  }
});

test('CLI rejects file:// URLs without --local-files', async () => {
  const { code, stderr } = await runCli([FIXTURE_URL]);
  assert.notEqual(code, 0);
  assert.match(stderr, /--local-files/);
});

test('CLI reads file:// URLs with --local-files', async () => {
  const { code, stdout } = await runCli(['--local-files', FIXTURE_URL]);
  assert.equal(code, 0);
  assert.match(stdout, /Alice/);
});

test('CLI rejects unsupported schemes', async () => {
  const { code, stderr } = await runCli(['ftp://example.org/resource']);
  assert.notEqual(code, 0);
  assert.match(stderr, /http/);
});

test('CLI rejects malformed URLs', async () => {
  const { code } = await runCli(['not-a-url']);
  assert.notEqual(code, 0);
});

test('CLI (issue #59) writes triples to stdout before the source has finished sending', async () => {
  let serverFinished = false;
  const { server, baseUrl } = await createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/turtle' });
    res.write('<https://example.org/alice> <http://xmlns.com/foaf/0.1/name> "first" .\n');
    setTimeout(() => {
      res.end('<https://example.org/alice> <http://xmlns.com/foaf/0.1/name> "second" .\n');
      serverFinished = true;
    }, 200);
  });

  try {
    const { execFile } = require('node:child_process');
    const child = execFile('node', [BIN, `${baseUrl}/log`]);
    const sawFirstTripleBeforeServerFinished = await new Promise((resolve, reject) => {
      let stdout = '';
      child.stdout.on('data', chunk => {
        stdout += chunk;
        if (stdout.includes('"first"')) {
          resolve(!serverFinished);
        }
      });
      child.on('error', reject);
      child.on('exit', () => resolve(false));
    });
    await new Promise(resolve => child.on('exit', resolve));

    assert.equal(sawFirstTripleBeforeServerFinished, true);
  } finally {
    await closeServer(server);
  }
});

test('CLI --frame still buffers the whole response (framing needs the full graph)', async () => {
  const { server, baseUrl } = await createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/turtle' });
    res.end('<#me> a <https://schema.org/Person>; <https://schema.org/name> "Alice" .');
  });

  try {
    const frame = JSON.stringify({ '@context': { schema: 'https://schema.org/' }, '@type': 'schema:Person' });
    const { code, stdout } = await runCli([`${baseUrl}/profile`, '--frame', frame]);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed['schema:name']['@value'], 'Alice');
  } finally {
    await closeServer(server);
  }
});

test('CLI --predicates still follows links via the buffered path', async () => {
  const { server, baseUrl } = await createServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(200, { 'content-type': 'text/turtle' });
      res.end(`<https://example.org/a> <https://example.org/next> <${baseUrl}/next> .`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/turtle' });
    res.end('<https://example.org/b> <https://schema.org/name> "followed" .');
  });

  try {
    const { code, stdout } = await runCli([`${baseUrl}/start`, '--predicates', 'https://example.org/next']);
    assert.equal(code, 0);
    assert.match(stdout, /followed/);
  } finally {
    await closeServer(server);
  }
});
