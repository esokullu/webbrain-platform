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
  activeProvider = 'webbrain_cloud',
} = {}) {
  const currentVersion = Number(current.webbrainCloudPresetVersion || 0);
  const presetApplied = !Number.isFinite(currentVersion)
    || currentVersion < WEBBRAIN_CLOUD_PRESET_VERSION;
  const runtimePatch = {
    webbrainCloudBridgeEnabled: true,
    webbrainCloudBridgeUrl: bridgeUrl,
    webbrainCloudManaged: true,
    activeProvider,
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

export function cloudPageMatchesStartUrl(page = {}, startUrl = '') {
  const startKey = normalizedPageKey(startUrl);
  return [page.url, page.pendingUrl]
    .filter(Boolean)
    .some(value => normalizedPageKey(value) === startKey);
}

export function buildCloudStartupTabPlan(targets = [], startUrl = '') {
  const closeTargetIds = [];
  let startPageUrl = '';

  for (const target of targets) {
    if (target.type !== 'page') continue;
    const isExtensionSettings = /^chrome-extension:\/\/[a-p]{32}\/src\/ui\/settings\.html(?:$|[?#])/.test(target.url || '');
    const isStartPage = cloudPageMatchesStartUrl(target, startUrl);
    if (isExtensionSettings || (isStartPage && startPageUrl)) {
      closeTargetIds.push(target.id);
      continue;
    }
    if (isStartPage) startPageUrl = target.url;
  }

  return { closeTargetIds, startPageUrl };
}

export function buildCloudStartupTabNormalizationExpression({
  startUrl = '',
  preferredUrl = '',
  waitMs = 5000,
  pollIntervalMs = 100,
} = {}) {
  const timeout = Math.max(0, Number(waitMs) || 0);
  const pollInterval = Math.max(0, Number(pollIntervalMs) || 0);
  return `
    (async () => {
      const normalizedPageKey = value => {
        try {
          const url = new URL(value);
          const hostname = url.hostname.replace(/^www\\./, '');
          const pathname = url.pathname.replace(/\\/+$/, '') || '/';
          return url.protocol + '//' + hostname + pathname + url.search;
        } catch {
          return String(value || '');
        }
      };
      const startUrl = ${JSON.stringify(startUrl)};
      const expected = new Set(
        [startUrl, ${JSON.stringify(preferredUrl)}]
          .filter(Boolean)
          .map(normalizedPageKey)
      );
      const deadline = Date.now() + ${JSON.stringify(timeout)};
      let tab = null;
      while (true) {
        const tabs = await chrome.tabs.query({});
        tab = tabs.find(item => [item.url, item.pendingUrl]
          .filter(Boolean)
          .some(value => expected.has(normalizedPageKey(value))));
        if (tab?.id || Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, ${JSON.stringify(pollInterval)}));
      }
      if (!tab?.id) {
        const created = await chrome.tabs.create({
          url: startUrl,
          active: true,
          pinned: true,
        });
        return { ok: true, tab_id: created.id, created: true };
      }
      await chrome.tabs.update(tab.id, { active: true, pinned: true });
      return { ok: true, tab_id: tab.id, created: false };
    })()
  `;
}
