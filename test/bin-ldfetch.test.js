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
