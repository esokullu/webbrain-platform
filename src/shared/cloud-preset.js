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

function normalizedPageKey(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^www\./, '');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    return `${url.protocol}//${hostname}${pathname}${url.search}`;
  } catch {
    return String(value || '');
  }
}

export function buildCloudStartupTabPlan(targets = [], startUrl = '') {
  const startKey = normalizedPageKey(startUrl);
  const closeTargetIds = [];
  let startPageUrl = '';

  for (const target of targets) {
    if (target.type !== 'page') continue;
    const isExtensionSettings = /^chrome-extension:\/\/[a-p]{32}\/src\/ui\/settings\.html(?:$|[?#])/.test(target.url || '');
    const isStartPage = normalizedPageKey(target.url) === startKey;
    if (isExtensionSettings || (isStartPage && startPageUrl)) {
      closeTargetIds.push(target.id);
      continue;
    }
    if (isStartPage) startPageUrl = target.url;
  }

  return { closeTargetIds, startPageUrl };
}
