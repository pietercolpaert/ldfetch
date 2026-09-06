'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const isAllowedProtocol = require('../lib/allowedProtocol.js');

test('allows http:// URLs', () => {
  assert.equal(isAllowedProtocol('http://example.org/resource'), true);
});

test('allows https:// URLs', () => {
  assert.equal(isAllowedProtocol('https://example.org/resource'), true);
});

test('rejects file:// URLs by default', () => {
  assert.equal(isAllowedProtocol('file:///etc/passwd'), false);
});

test('allows file:// URLs when localFiles is enabled', () => {
  assert.equal(isAllowedProtocol('file:///etc/passwd', { localFiles: true }), true);
});

test('rejects unsupported schemes even when localFiles is enabled', () => {
  assert.equal(isAllowedProtocol('ftp://example.org/resource', { localFiles: true }), false);
  assert.equal(isAllowedProtocol('data:text/plain,hello', { localFiles: true }), false);
});

test('rejects malformed URLs', () => {
  assert.equal(isAllowedProtocol('not a url'), false);
  assert.equal(isAllowedProtocol(''), false);
});
