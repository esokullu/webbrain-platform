import net from 'node:net';

export const WEBBRAIN_CONFIG_SCHEMA = 'webbrain-config/1';
export const WEBBRAIN_CONFIG_ENV = 'WEBBRAIN_CONFIG_B64';
export const MAX_WEBBRAIN_CONFIG_BYTES = 32 * 1024;

const BOOLEAN_SETTINGS = new Set([
  'verboseMode',
  'selectionShortcutEnabled',
  'helpImproveWebBrain',
  'voiceInputEnabled',
  'notifySound',
  'completionConfetti',
  'screenshotFallback',
  'useSiteAdapters',
  'apiMutationObserverEnabled',
  'screenshotRedaction',
  'captchaSolverEnabled',
]);

const PLATFORM_MANAGED_SETTINGS = new Set([
  'planBeforeActMode',
  'planBeforeAct',
  'planReviewMode',
  'planReviewConfidenceThreshold',
  'askBeforeConsequentialActions',
  'tracingEnabled',
  'downloadDirectory',
  'agentAllowLocalNetwork',
  'strictSecretMode',
  'scheduledTasksEnabled',
  'scheduledRequireConsequentialConfirmation',
  'wb_permissions',
  'visionModel',
  'transcriptionModel',
  'profileEnabled',
  'profileText',
  'wb_user_memory_v1',
  'userMemoryEnabled',
  'userMemoryAutoCaptureEnabled',
  'userMemoryFormCaptureEnabled',
  'userMemoryMaxPromptChars',
  'customSkills',
  'defaultSkillsRemoved',
  'clarifyTimeoutSemanticsV2',
  'webbrainCloudBridgeEnabled',
  'webbrainCloudBridgeUrl',
  'webbrainCloudManaged',
  'webbrainCloudPresetVersion',
  'onboardingComplete',
]);

const SUPPORTED_LOCALES = new Set([
  'ar', 'en', 'es', 'fr', 'he', 'id', 'ja', 'ko',
  'ms', 'pl', 'ru', 'th', 'tl', 'tr', 'uk', 'zh',
]);
const THEME_MODES = new Set(['system', 'light', 'dark']);
const PROVIDER_FILTERS = new Set(['all', 'local', 'cloud', 'router']);
const AUTO_SCREENSHOT_MODES = new Set(['off', 'navigation', 'state_change', 'every_step']);
const SUPPORTED_PROVIDER_TYPES = new Set([
  'llamacpp',
  'openai',
  'azure_openai',
  'aws_bedrock',
  'anthropic',
  'anthropic_oauth',
]);
const RESERVED_PROVIDER_IDS = new Set([
  'webbrain_cloud',
  'webbrain',
  'openai_subscription',
  'claude_subscription',
]);
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const PROVIDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PROVIDER_CREDENTIAL_KEYS = [
  'apiKey',
  'accessKeyId',
  'secretAccessKey',
  'sessionToken',
  'oauthToken',
  'accessToken',
];

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function containsUnsafeObjectKey(value) {
  if (Array.isArray(value)) return value.some(containsUnsafeObjectKey);
  if (!isPlainObject(value)) return false;
  return Object.entries(value).some(([key, nested]) => (
    UNSAFE_OBJECT_KEYS.has(key) || containsUnsafeObjectKey(nested)
  ));
}

function byteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function ignored(field, reason) {
  return { field, reason };
}

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  return parts[0] === 10
    || parts[0] === 127
    || parts[0] === 0
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
    || parts[0] >= 224;
}

function isPrivateHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (
    host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || host === 'metadata.google.internal'
  ) {
    return true;
  }
  const family = net.isIP(host);
  if (family === 4) return isPrivateIpv4(host);
  if (family === 6) {
    return host === '::1'
      || host === '::'
      || host.startsWith('fc')
      || host.startsWith('fd')
      || /^fe[89ab]/.test(host)
      || host.startsWith('::ffff:127.')
      || host.startsWith('::ffff:10.')
      || host.startsWith('::ffff:192.168.');
  }
  return false;
}

function validPublicProviderUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value.replace(/\{[^}]+\}/g, 'placeholder'));
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && !isPrivateHostname(url.hostname);
  } catch {
    return false;
  }
}

function providerConfigured(config) {
  if (config.configured === true && config.enabled !== false) return true;
  if (config.configured === false || config.enabled === false) return false;
  return PROVIDER_CREDENTIAL_KEYS.some(key => (
    typeof config[key] === 'string' && config[key].trim() !== ''
  ));
}

function sanitizeProviders(value, result) {
  if (!isPlainObject(value)) {
    result.ignored.push(ignored('settings.providers', 'invalid_type'));
    return null;
  }

  const providers = {};
  const entries = Object.entries(value);
  if (entries.length > 64) {
    result.ignored.push(ignored('settings.providers', 'too_many_providers'));
    return null;
  }

  for (const [id, rawConfig] of entries) {
    const field = `settings.providers.${id}`;
    if (!PROVIDER_ID_RE.test(id) || UNSAFE_OBJECT_KEYS.has(id)) {
      result.ignored.push(ignored(field, 'invalid_provider_id'));
      continue;
    }
    if (RESERVED_PROVIDER_IDS.has(id)) {
      result.ignored.push(ignored(field, 'platform_managed'));
      continue;
    }
    if (!isPlainObject(rawConfig)) {
      result.ignored.push(ignored(field, 'invalid_provider_config'));
      continue;
    }
    if (containsUnsafeObjectKey(rawConfig)) {
      result.ignored.push(ignored(field, 'invalid_provider_config'));
      continue;
    }
    if (!SUPPORTED_PROVIDER_TYPES.has(rawConfig.type)) {
      result.ignored.push(ignored(field, 'unsupported_provider_type'));
      continue;
    }
    if (rawConfig.type === 'llamacpp' || rawConfig.category === 'local') {
      result.ignored.push(ignored(field, 'local_provider_unavailable'));
      continue;
    }
    if (Object.hasOwn(rawConfig, 'baseUrl') && !validPublicProviderUrl(rawConfig.baseUrl)) {
      result.ignored.push(ignored(field, 'invalid_provider_url'));
      continue;
    }
    if (Object.hasOwn(rawConfig, 'configured') && typeof rawConfig.configured !== 'boolean') {
      result.ignored.push(ignored(field, 'invalid_provider_config'));
      continue;
    }
    if (Object.hasOwn(rawConfig, 'enabled') && typeof rawConfig.enabled !== 'boolean') {
      result.ignored.push(ignored(field, 'invalid_provider_config'));
      continue;
    }
    if (byteLength(rawConfig) > 8 * 1024) {
      result.ignored.push(ignored(field, 'provider_config_too_large'));
      continue;
    }

    const config = cloneJson(rawConfig);
    delete config.deviceGuid;
    providers[id] = config;
    result.accepted.push(field);
  }

  if (entries.length === 0) {
    result.accepted.push('settings.providers');
    return providers;
  }
  return Object.keys(providers).length ? providers : null;
}

function acceptBoolean(key, value, patch, result) {
  if (typeof value !== 'boolean') {
    result.ignored.push(ignored(`settings.${key}`, 'invalid_type'));
    return;
  }
  patch[key] = value;
  result.accepted.push(`settings.${key}`);
}

function acceptEnum(key, value, allowed, patch, result) {
  if (typeof value !== 'string') {
    result.ignored.push(ignored(`settings.${key}`, 'invalid_type'));
    return;
  }
  if (!allowed.has(value)) {
    result.ignored.push(ignored(`settings.${key}`, 'invalid_value'));
    return;
  }
  patch[key] = value;
  result.accepted.push(`settings.${key}`);
}

function acceptNumber(key, value, predicate, patch, result) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    result.ignored.push(ignored(`settings.${key}`, 'invalid_type'));
    return;
  }
  if (!predicate(value)) {
    result.ignored.push(ignored(`settings.${key}`, 'value_out_of_range'));
    return;
  }
  patch[key] = value;
  result.accepted.push(`settings.${key}`);
}

export function sanitizeWebBrainConfig(value) {
  const result = { accepted: [], ignored: [], warnings: [] };
  if (value === undefined) {
    return { supplied: false, config: null, result: null };
  }
  if (!isPlainObject(value)) {
    result.ignored.push(ignored('webbrain_config', 'invalid_type'));
    return { supplied: true, config: null, result };
  }
  if (byteLength(value) > MAX_WEBBRAIN_CONFIG_BYTES) {
    result.ignored.push(ignored('webbrain_config', 'config_too_large'));
    return { supplied: true, config: null, result };
  }
  if (value.schema !== WEBBRAIN_CONFIG_SCHEMA) {
    result.ignored.push(ignored('webbrain_config.schema', 'invalid_schema'));
    return { supplied: true, config: null, result };
  }
  if (!isPlainObject(value.settings)) {
    result.ignored.push(ignored('webbrain_config.settings', 'invalid_type'));
    return { supplied: true, config: null, result };
  }

  const patch = {};
  let requestedActiveProvider;

  for (const [key, settingValue] of Object.entries(value.settings)) {
    if (BOOLEAN_SETTINGS.has(key)) {
      acceptBoolean(key, settingValue, patch, result);
      continue;
    }
    if (PLATFORM_MANAGED_SETTINGS.has(key)) {
      result.ignored.push(ignored(`settings.${key}`, 'platform_managed'));
      continue;
    }
    switch (key) {
      case 'wbLocale':
        acceptEnum(key, settingValue, SUPPORTED_LOCALES, patch, result);
        break;
      case 'themeMode':
        acceptEnum(key, settingValue, THEME_MODES, patch, result);
        break;
      case 'providerFilter':
        acceptEnum(key, settingValue, PROVIDER_FILTERS, patch, result);
        break;
      case 'autoScreenshot':
        acceptEnum(key, settingValue, AUTO_SCREENSHOT_MODES, patch, result);
        break;
      case 'maxAgentSteps':
        acceptNumber(key, settingValue, number => (
          Number.isInteger(number) && (number === 0 || (number >= 5 && number <= 195))
        ), patch, result);
        break;
      case 'requestTimeoutMs':
        acceptNumber(key, settingValue, number => (
          Number.isInteger(number) && number >= 10_000 && number <= 600_000
        ), patch, result);
        break;
      case 'clarifyTimeoutSec':
        acceptNumber(key, settingValue, number => (
          Number.isInteger(number) && number >= 0 && number <= 1205
        ), patch, result);
        if (Object.hasOwn(patch, key)) patch.clarifyTimeoutSemanticsV2 = true;
        break;
      case 'costAllowanceSessionUsd':
      case 'costAllowanceTotalUsd':
        acceptNumber(key, settingValue, number => number >= 0, patch, result);
        break;
      case 'capsolverApiKey':
        if (typeof settingValue !== 'string') {
          result.ignored.push(ignored(`settings.${key}`, 'invalid_type'));
        } else if (settingValue.length > 4096) {
          result.ignored.push(ignored(`settings.${key}`, 'value_too_large'));
        } else {
          patch[key] = settingValue;
          result.accepted.push(`settings.${key}`);
        }
        break;
      case 'providers': {
        const providers = sanitizeProviders(settingValue, result);
        if (providers !== null) patch.providers = providers;
        break;
      }
      case 'activeProvider':
        requestedActiveProvider = settingValue;
        break;
      default:
        result.ignored.push(ignored(`settings.${key}`, 'unsupported_setting'));
    }
  }

  if (requestedActiveProvider !== undefined) {
    if (typeof requestedActiveProvider !== 'string') {
      result.ignored.push(ignored('settings.activeProvider', 'invalid_type'));
    } else if (requestedActiveProvider === 'webbrain_cloud') {
      patch.activeProvider = requestedActiveProvider;
      result.accepted.push('settings.activeProvider');
    } else if (
      patch.providers
      && Object.hasOwn(patch.providers, requestedActiveProvider)
      && providerConfigured(patch.providers[requestedActiveProvider])
    ) {
      patch.activeProvider = requestedActiveProvider;
      result.accepted.push('settings.activeProvider');
      result.warnings.push({
        code: 'external_provider_active',
        message: 'Model traffic and provider charges will use the selected external provider.',
      });
    } else {
      result.ignored.push(ignored('settings.activeProvider', 'provider_not_configured'));
    }
  }

  if (
    patch.captchaSolverEnabled === true
    && (!Object.hasOwn(patch, 'capsolverApiKey') || patch.capsolverApiKey.trim() === '')
  ) {
    result.warnings.push({
      code: 'capsolver_enabled_without_api_key',
      message: 'CapSolver is enabled but no non-empty API key was supplied.',
    });
  }

  const config = Object.keys(patch).length
    ? { schema: WEBBRAIN_CONFIG_SCHEMA, settings: patch }
    : null;
  return { supplied: true, config, result };
}

export function encodeWebBrainConfig(config) {
  if (!config) return '';
  return Buffer.from(JSON.stringify(config), 'utf8').toString('base64');
}

export function decodeWebBrainConfig(encoded) {
  const text = String(encoded || '').trim();
  if (!text) return null;
  const raw = Buffer.from(text, 'base64').toString('utf8');
  if (Buffer.byteLength(raw, 'utf8') > MAX_WEBBRAIN_CONFIG_BYTES) {
    throw new Error('WebBrain config payload is too large.');
  }
  const parsed = JSON.parse(raw);
  if (
    !isPlainObject(parsed)
    || parsed.schema !== WEBBRAIN_CONFIG_SCHEMA
    || !isPlainObject(parsed.settings)
  ) {
    throw new Error('WebBrain config payload is invalid.');
  }
  return parsed;
}
