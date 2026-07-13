import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WEBBRAIN_CLOUD_PRESET_VERSION,
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
