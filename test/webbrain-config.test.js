import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeWebBrainConfig,
  encodeWebBrainConfig,
  sanitizeWebBrainConfig,
} from '../src/shared/webbrain-config.js';

test('webbrain export config is sanitized as a sparse settings patch', () => {
  const sanitized = sanitizeWebBrainConfig({
    schema: 'webbrain-config/1',
    exportedAt: '2026-07-19T10:00:00.000Z',
    webbrainVersion: '7.3.0',
    warning: 'contains secrets',
    settings: {
      themeMode: 'dark',
      screenshotFallback: true,
      maxAgentSteps: 130,
      clarifyTimeoutSec: 60,
      captchaSolverEnabled: true,
      capsolverApiKey: 'capsolver-secret',
      planBeforeActMode: 'strict',
      unknownSetting: 'ignored',
    },
  });

  assert.equal(sanitized.supplied, true);
  assert.deepEqual(sanitized.config, {
    schema: 'webbrain-config/1',
    settings: {
      themeMode: 'dark',
      screenshotFallback: true,
      maxAgentSteps: 130,
      clarifyTimeoutSec: 60,
      clarifyTimeoutSemanticsV2: true,
      captchaSolverEnabled: true,
      capsolverApiKey: 'capsolver-secret',
    },
  });
  assert.deepEqual(sanitized.result.accepted, [
    'settings.themeMode',
    'settings.screenshotFallback',
    'settings.maxAgentSteps',
    'settings.clarifyTimeoutSec',
    'settings.captchaSolverEnabled',
    'settings.capsolverApiKey',
  ]);
  assert.deepEqual(sanitized.result.ignored, [
    { field: 'settings.planBeforeActMode', reason: 'platform_managed' },
    { field: 'settings.unknownSetting', reason: 'unsupported_setting' },
  ]);
});

test('provider configs merge safely and activeProvider only accepts configured providers', () => {
  const sanitized = sanitizeWebBrainConfig({
    schema: 'webbrain-config/1',
    settings: {
      providers: {
        webbrain_cloud: {
          type: 'openai',
          baseUrl: 'https://attacker.example/v1',
          apiKey: 'must-not-pass',
        },
        openrouter: {
          type: 'openai',
          category: 'router',
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: 'provider-secret',
          configured: true,
          enabled: true,
          deviceGuid: 'must-be-stripped',
        },
        vllm: {
          type: 'openai',
          category: 'local',
          baseUrl: 'http://127.0.0.1:8000/v1',
          configured: true,
        },
      },
      activeProvider: 'openrouter',
    },
  });

  assert.equal(sanitized.config.settings.activeProvider, 'openrouter');
  assert.deepEqual(sanitized.config.settings.providers.openrouter, {
    type: 'openai',
    category: 'router',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'provider-secret',
    configured: true,
    enabled: true,
  });
  assert.equal(Object.hasOwn(sanitized.config.settings.providers, 'webbrain_cloud'), false);
  assert.equal(Object.hasOwn(sanitized.config.settings.providers, 'vllm'), false);
  assert.deepEqual(sanitized.result.ignored, [
    { field: 'settings.providers.webbrain_cloud', reason: 'platform_managed' },
    { field: 'settings.providers.vllm', reason: 'local_provider_unavailable' },
  ]);
  assert.equal(sanitized.result.warnings[0].code, 'external_provider_active');
});

test('invalid config fields are reported without rejecting the whole config', () => {
  const sanitized = sanitizeWebBrainConfig({
    schema: 'webbrain-config/1',
    settings: {
      themeMode: 'ultraviolet',
      requestTimeoutMs: 1,
      completionConfetti: 'yes',
      providers: {
        private: {
          type: 'openai',
          baseUrl: 'https://127.0.0.1/v1',
          configured: true,
        },
      },
      activeProvider: 'private',
      captchaSolverEnabled: true,
    },
  });

  assert.deepEqual(sanitized.config.settings, { captchaSolverEnabled: true });
  assert.deepEqual(sanitized.result.ignored, [
    { field: 'settings.themeMode', reason: 'invalid_value' },
    { field: 'settings.requestTimeoutMs', reason: 'value_out_of_range' },
    { field: 'settings.completionConfetti', reason: 'invalid_type' },
    { field: 'settings.providers.private', reason: 'invalid_provider_url' },
    { field: 'settings.activeProvider', reason: 'provider_not_configured' },
  ]);
  assert.equal(sanitized.result.warnings[0].code, 'capsolver_enabled_without_api_key');
});

test('missing config is distinct from invalid schema and encoding never leaks into results', () => {
  assert.deepEqual(sanitizeWebBrainConfig(undefined), {
    supplied: false,
    config: null,
    result: null,
  });

  const invalid = sanitizeWebBrainConfig({ schema: 'other', settings: {} });
  assert.equal(invalid.config, null);
  assert.deepEqual(invalid.result.ignored, [
    { field: 'webbrain_config.schema', reason: 'invalid_schema' },
  ]);

  const sanitized = sanitizeWebBrainConfig({
    schema: 'webbrain-config/1',
    settings: { capsolverApiKey: 'do-not-echo' },
  });
  const encoded = encodeWebBrainConfig(sanitized.config);
  assert.deepEqual(decodeWebBrainConfig(encoded), sanitized.config);
  assert.equal(JSON.stringify(sanitized.result).includes('do-not-echo'), false);
});

test('provider ids and configs cannot inject object prototype keys', () => {
  const providers = JSON.parse(`{
    "__proto__": {
      "type": "openai",
      "baseUrl": "https://provider.example/v1",
      "configured": true
    },
    "safe": {
      "type": "openai",
      "baseUrl": "https://provider.example/v1",
      "configured": true,
      "__proto__": {"polluted": true}
    }
  }`);
  const sanitized = sanitizeWebBrainConfig({
    schema: 'webbrain-config/1',
    settings: { providers },
  });

  assert.equal(sanitized.config, null);
  assert.deepEqual(sanitized.result.ignored, [
    { field: 'settings.providers.__proto__', reason: 'invalid_provider_id' },
    { field: 'settings.providers.safe', reason: 'invalid_provider_config' },
  ]);
  assert.equal({}.polluted, undefined);
});
