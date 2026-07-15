import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WEBBRAIN_CLOUD_PRESET_VERSION,
  buildCloudStartupTabNormalizationExpression,
  buildCloudStartupTabPlan,
  buildCloudStoragePatch,
  storagePatchMismatches,
} from '../src/shared/cloud-preset.js';

test('fresh cloud profiles receive the noninteractive first-run preset', () => {
  const result = buildCloudStoragePatch({}, {
    bridgeUrl: 'ws://127.0.0.1:17373/extension',
    tracingEnabled: true,
  });

  assert.equal(result.presetApplied, true);
  assert.equal(result.presetVersion, WEBBRAIN_CLOUD_PRESET_VERSION);
  assert.equal(result.patch.onboardingComplete, true);
  assert.equal(result.patch.planBeforeActMode, 'off');
  assert.equal(result.patch.planBeforeAct, false);
  assert.equal(result.patch.planReviewMode, 'never');
  assert.equal(result.patch.askBeforeConsequentialActions, false);
  assert.equal(result.patch.webbrainCloudPresetVersion, WEBBRAIN_CLOUD_PRESET_VERSION);
  assert.equal(result.patch.activeProvider, 'webbrain_cloud');
});

test('versioned cloud profiles preserve user preferences while refreshing runtime wiring', () => {
  const result = buildCloudStoragePatch({
    webbrainCloudPresetVersion: WEBBRAIN_CLOUD_PRESET_VERSION,
    planBeforeActMode: 'try',
    planReviewMode: 'always',
  }, {
    bridgeUrl: 'ws://127.0.0.1:19999/extension',
    tracingEnabled: false,
  });

  assert.equal(result.presetApplied, false);
  assert.equal('planBeforeActMode' in result.patch, false);
  assert.equal('planReviewMode' in result.patch, false);
  assert.equal('onboardingComplete' in result.patch, false);
  assert.equal(result.patch.webbrainCloudBridgeUrl, 'ws://127.0.0.1:19999/extension');
  assert.equal(result.patch.webbrainCloudBridgeEnabled, true);
  assert.equal(result.patch.webbrainCloudManaged, true);
  assert.equal(result.patch.activeProvider, 'webbrain_cloud');
  assert.equal(result.patch.tracingEnabled, false);
});

test('cloud storage verification identifies only mismatched keys', () => {
  const expected = { activeProvider: 'webbrain_cloud', onboardingComplete: true };
  assert.deepEqual(storagePatchMismatches(expected, expected), []);
  assert.deepEqual(
    storagePatchMismatches({ ...expected, onboardingComplete: false }, expected),
    ['onboardingComplete'],
  );
});

test('cloud startup keeps one start page and closes extension settings pages', () => {
  const plan = buildCloudStartupTabPlan([
    { id: 'settings-current', type: 'page', url: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/src/ui/settings.html' },
    { id: 'start-one', type: 'page', url: 'https://www.webbrain.one/' },
    { id: 'start-two', type: 'page', url: 'https://webbrain.one' },
    { id: 'worker', type: 'service_worker', url: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/background.js' },
    { id: 'other', type: 'page', url: 'https://example.com/' },
  ], 'https://webbrain.one');

  assert.deepEqual(plan, {
    closeTargetIds: ['settings-current', 'start-two'],
    startPageUrl: 'https://www.webbrain.one/',
  });
});

test('cloud startup recognizes a loading start page by pendingUrl and pins it', async () => {
  const updates = [];
  let createCalls = 0;
  const chrome = {
    tabs: {
      query: async () => [{
        id: 42,
        url: '',
        pendingUrl: 'https://www.webbrain.one/',
        status: 'loading',
      }],
      update: async (id, tabPatch) => updates.push({ id, patch: tabPatch }),
      create: async () => {
        createCalls += 1;
        return { id: 99 };
      },
    },
  };
  const expression = buildCloudStartupTabNormalizationExpression({
    startUrl: 'https://webbrain.one',
    waitMs: 0,
    pollIntervalMs: 0,
  });
  const result = await Function('chrome', `return (${expression})`)(chrome);

  assert.deepEqual(result, { ok: true, tab_id: 42, created: false });
  assert.deepEqual(updates, [{ id: 42, patch: { active: true, pinned: true } }]);
  assert.equal(createCalls, 0);
});

test('cloud startup creates a pinned start page when no matching tab appears', async () => {
  const creates = [];
  const chrome = {
    tabs: {
      query: async () => [],
      update: async () => {
        throw new Error('unexpected update');
      },
      create: async options => {
        creates.push(options);
        return { id: 77 };
      },
    },
  };
  const expression = buildCloudStartupTabNormalizationExpression({
    startUrl: 'https://webbrain.one',
    waitMs: 0,
    pollIntervalMs: 0,
  });
  const result = await Function('chrome', `return (${expression})`)(chrome);

  assert.deepEqual(result, { ok: true, tab_id: 77, created: true });
  assert.deepEqual(creates, [{
    url: 'https://webbrain.one',
    active: true,
    pinned: true,
  }]);
});
