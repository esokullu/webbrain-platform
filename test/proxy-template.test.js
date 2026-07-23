import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfiguredProxyUrl } from '../src/shared/proxy.js';

test('resolveConfiguredProxyUrl substitutes location into % placeholders when present', () => {
  const template = 'http://ervyombx-%:k8lwfjyglypp@p.webshare.io:80';

  assert.equal(
    resolveConfiguredProxyUrl(template, 'us'),
    'http://ervyombx-us:k8lwfjyglypp@p.webshare.io:80'
  );
  assert.equal(
    resolveConfiguredProxyUrl(template, 'de'),
    'http://ervyombx-de:k8lwfjyglypp@p.webshare.io:80'
  );
  assert.equal(
    resolveConfiguredProxyUrl(template, 'GB'),
    'http://ervyombx-gb:k8lwfjyglypp@p.webshare.io:80'
  );
});

test('resolveConfiguredProxyUrl falls back to rotate when location is missing or ineligible', () => {
  const template = 'http://ervyombx-%:k8lwfjyglypp@p.webshare.io:80';

  assert.equal(
    resolveConfiguredProxyUrl(template, ''),
    'http://ervyombx-rotate:k8lwfjyglypp@p.webshare.io:80'
  );
  assert.equal(
    resolveConfiguredProxyUrl(template, null),
    'http://ervyombx-rotate:k8lwfjyglypp@p.webshare.io:80'
  );
  assert.equal(
    resolveConfiguredProxyUrl(template, 'invalid country with spaces'),
    'http://ervyombx-rotate:k8lwfjyglypp@p.webshare.io:80'
  );
  assert.equal(
    resolveConfiguredProxyUrl(template, '!@#$%^&*'),
    'http://ervyombx-rotate:k8lwfjyglypp@p.webshare.io:80'
  );
});

test('resolveConfiguredProxyUrl ignores location when server env proxy URL has no %', () => {
  const staticUrl = 'http://ervyombx-rotate:k8lwfjyglypp@p.webshare.io:80';

  assert.equal(
    resolveConfiguredProxyUrl(staticUrl, 'us'),
    'http://ervyombx-rotate:k8lwfjyglypp@p.webshare.io:80'
  );
  assert.equal(
    resolveConfiguredProxyUrl(staticUrl, 'de'),
    'http://ervyombx-rotate:k8lwfjyglypp@p.webshare.io:80'
  );
  assert.equal(
    resolveConfiguredProxyUrl(staticUrl, ''),
    'http://ervyombx-rotate:k8lwfjyglypp@p.webshare.io:80'
  );
});
