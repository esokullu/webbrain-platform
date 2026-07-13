export const WEBBRAIN_CLOUD_PRESET_VERSION = 1;

export const WEBBRAIN_CLOUD_FIRST_RUN_PRESET = Object.freeze({
  onboardingComplete: true,
  planBeforeActMode: 'off',
  planBeforeAct: false,
  planReviewMode: 'never',
  askBeforeConsequentialActions: false,
  webbrainCloudPresetVersion: WEBBRAIN_CLOUD_PRESET_VERSION,
});

export function buildCloudStoragePatch(current = {}, {
  bridgeUrl,
  tracingEnabled = true,
} = {}) {
  const currentVersion = Number(current.webbrainCloudPresetVersion || 0);
  const presetApplied = !Number.isFinite(currentVersion)
    || currentVersion < WEBBRAIN_CLOUD_PRESET_VERSION;
  const runtimePatch = {
    webbrainCloudBridgeEnabled: true,
    webbrainCloudBridgeUrl: bridgeUrl,
    webbrainCloudManaged: true,
    activeProvider: 'webbrain_cloud',
    tracingEnabled: tracingEnabled !== false,
  };

  return {
    patch: presetApplied
      ? { ...runtimePatch, ...WEBBRAIN_CLOUD_FIRST_RUN_PRESET }
      : runtimePatch,
    presetApplied,
    presetVersion: WEBBRAIN_CLOUD_PRESET_VERSION,
  };
}

export function storagePatchMismatches(actual = {}, expected = {}) {
  return Object.entries(expected)
    .filter(([key, value]) => JSON.stringify(actual[key]) !== JSON.stringify(value))
    .map(([key]) => key);
}
