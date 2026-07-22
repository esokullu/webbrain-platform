export const SAVED_WORKFLOW_SCHEMA = 'webbrain-workflow/1';
export const MAX_SAVED_WORKFLOWS = 100;
export const MAX_WORKFLOW_STEPS = 100;
export const MAX_WORKFLOW_PARAMETERS = 50;
export const MAX_PORTABLE_WORKFLOW_BYTES = 1024 * 1024;

const WORKFLOW_PARAM_REF_KEY = '$workflowParam';
const TARGET_MATCH_THRESHOLD = 7;
const REPLAYABLE_TOOLS = new Set([
  'navigate', 'go_back', 'go_forward', 'click', 'click_ax', 'set_checked',
  'type_ax', 'set_field', 'scroll', 'wait_for_element',
]);
const TARGET_FIELDS = [
  'role', 'name', 'label', 'id', 'fieldName', 'type', 'ariaLabel',
  'placeholder', 'href',
];

function workflowError(message, status = 422) {
  return Object.assign(new Error(message), { status });
}

function cleanText(value, max = 240) {
  const text = String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? text.slice(0, max).trim() : text;
}

function cleanId(value, fallback = '') {
  return cleanText(value, 100).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || fallback;
}

function timestamp(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function normalizeScope(input) {
  const origin = cleanText(input?.origin, 300);
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) return null;
  } catch {
    return null;
  }
  const pathFamily = cleanText(input?.pathFamily || '/', 500) || '/';
  if (!pathFamily.startsWith('/')) return null;
  return { origin, pathFamily };
}

function normalizeTarget(input) {
  const target = {};
  for (const field of TARGET_FIELDS) {
    const value = cleanText(input?.[field]);
    if (!value || /^ref_[A-Za-z0-9_-]+$/i.test(value)) continue;
    target[field] = field === 'href' ? (safeHttpUrl(value) || value) : value;
  }
  return Object.keys(target).length ? target : null;
}

function normalizeComparable(value) {
  return cleanText(value, 500).toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function targetScore(input) {
  const target = normalizeTarget(input);
  if (!target) return 0;
  return [
    ['id', 12],
    ['fieldName', 9],
    ['label', 8],
    ['ariaLabel', 8],
    ['name', 7],
    ['href', 7],
    ['placeholder', 5],
    ['type', 3],
    ['role', 2],
  ].reduce((score, [field, points]) => score + (normalizeComparable(target[field]) ? points : 0), 0);
}

function normalizeParameter(input) {
  const id = cleanId(input?.id).toLowerCase();
  if (!id) return null;
  return {
    id,
    label: cleanText(input?.label || id, 120),
    required: input?.required !== false,
    sensitive: input?.sensitive === true,
    type: 'text',
  };
}

function normalizeArgsValue(value, parameterIds, depth = 0) {
  if (depth > 6) return undefined;
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (/^ref_[A-Za-z0-9_-]+$/i.test(value)) return undefined;
    return cleanText(value, 1000);
  }
  if (Array.isArray(value)) {
    const normalized = value.map(item => normalizeArgsValue(item, parameterIds, depth + 1));
    return normalized.some(item => item === undefined) ? undefined : normalized;
  }
  if (typeof value !== 'object') return undefined;
  if (Object.keys(value).length === 1 && Object.hasOwn(value, WORKFLOW_PARAM_REF_KEY)) {
    const id = cleanId(value[WORKFLOW_PARAM_REF_KEY]).toLowerCase();
    return parameterIds.has(id) ? { [WORKFLOW_PARAM_REF_KEY]: id } : undefined;
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(ref_?id|x|y|index|replayRequestId|apiReplayRequestId)$/i.test(key)) return undefined;
    const normalized = normalizeArgsValue(item, parameterIds, depth + 1);
    if (normalized === undefined) return undefined;
    out[key] = normalized;
  }
  return out;
}

function normalizeExpected(input) {
  const kind = cleanText(input?.kind, 40);
  if (!['tool_success', 'tool_verified', 'url_changed', 'checked'].includes(kind)) {
    return { kind: 'tool_success' };
  }
  return kind === 'checked' ? { kind, value: input?.value === true } : { kind };
}

export function portableWorkflowByteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function normalizePortableWorkflowDefinition(value, options = {}) {
  const invalidStatus = options.invalidStatus || 422;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw workflowError('Invalid portable workflow definition.', invalidStatus);
  }
  if (portableWorkflowByteLength(value) > MAX_PORTABLE_WORKFLOW_BYTES) {
    throw workflowError('Portable workflow definitions must not exceed 1 MiB.', 413);
  }
  if (value.schema !== SAVED_WORKFLOW_SCHEMA) {
    throw workflowError('Unsupported portable workflow schema.', invalidStatus);
  }
  const inputParameters = Array.isArray(value.parameters) ? value.parameters : [];
  const inputSteps = Array.isArray(value.steps) ? value.steps : [];
  if (inputParameters.length > MAX_WORKFLOW_PARAMETERS || inputSteps.length > MAX_WORKFLOW_STEPS) {
    throw workflowError('The workflow exceeds WebBrain workflow limits.', 422);
  }

  const parameters = [];
  const parameterIds = new Set();
  for (const input of inputParameters) {
    const parameter = normalizeParameter(input);
    if (!parameter || parameterIds.has(parameter.id)) continue;
    parameterIds.add(parameter.id);
    parameters.push(parameter);
  }

  const steps = [];
  for (const raw of inputSteps) {
    const tool = cleanText(raw?.tool, 80);
    if (!REPLAYABLE_TOOLS.has(tool)) continue;
    let args = normalizeArgsValue(raw?.args || {}, parameterIds);
    if (!args || typeof args !== 'object' || Array.isArray(args)) continue;
    if (tool === 'navigate') {
      const url = safeHttpUrl(args.url);
      if (!url) continue;
      args = { url };
    }
    if (tool === 'click') {
      const text = cleanText(args.text);
      if (!text) continue;
      args = { text };
    }
    if (tool === 'wait_for_element') {
      const text = cleanText(args.text);
      if (!text) continue;
      const timeout = Number(args.timeout);
      args = {
        text,
        ...(Number.isFinite(timeout) ? { timeout: Math.max(100, Math.min(30000, Math.round(timeout))) } : {}),
      };
    }
    if ((tool === 'type_ax' || tool === 'set_field') && !args.text?.[WORKFLOW_PARAM_REF_KEY]) continue;
    const target = normalizeTarget(raw?.target);
    const scope = normalizeScope(raw?.scope);
    if (['click_ax', 'set_checked', 'type_ax', 'set_field'].includes(tool)
        && targetScore(target) < TARGET_MATCH_THRESHOLD) continue;
    steps.push({
      id: cleanId(raw?.id, `step_${steps.length + 1}`),
      tool,
      args,
      ...(target ? { target } : {}),
      ...(scope ? { scope } : {}),
      expected: normalizeExpected(raw?.expected),
    });
  }

  if (!steps.length) throw workflowError('No safe replayable steps were found.', 422);
  if (options.strict && (parameters.length !== inputParameters.length || steps.length !== inputSteps.length)) {
    throw workflowError('The portable workflow contains unsafe or invalid descriptors.', 422);
  }
  const start = normalizeScope(value.start);
  if (!start) throw workflowError('The workflow has an invalid start URL family.', invalidStatus);

  const now = Number(options.now) || Date.now();
  const name = cleanText(options.name ?? value.name, 80);
  if (!name) throw workflowError('`name` is required.', 400);
  const createdAt = options.resetTimestamps ? now : timestamp(value.createdAt, now);
  return {
    schema: SAVED_WORKFLOW_SCHEMA,
    id: cleanId(options.id, cleanId(value.id, 'workflow')),
    name,
    createdAt,
    updatedAt: options.resetTimestamps ? now : timestamp(options.updatedAt ?? value.updatedAt, createdAt),
    source: {
      runId: cleanId(value.source?.runId),
      webbrainVersion: cleanText(value.source?.webbrainVersion, 40),
    },
    start,
    parameters,
    steps,
    stats: {
      sourceToolCount: Math.max(0, Math.floor(Number(value.stats?.sourceToolCount) || 0)),
      compiledStepCount: steps.length,
      skippedToolCount: Math.max(0, Math.floor(Number(value.stats?.skippedToolCount) || 0)),
    },
  };
}
