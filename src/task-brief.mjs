import path from 'node:path';
import { OrchestratorError } from './errors.mjs';

const BRIEF_KEYS = new Set([
  'version',
  'taskKind',
  'risk',
  'contextRefs',
  'knownFindings',
  'nonGoals',
  'acceptance',
  'contextDependency',
  'independent',
  'requiredCapabilities',
]);

const TASK_KINDS = new Set(['bugfix', 'feature', 'refactor', 'docs', 'investigation', 'review', 'other']);
const RISKS = new Set(['low', 'medium', 'high']);
const CONTEXT_DEPENDENCIES = new Set(['low', 'high']);
const GLOB_CHARS = /[*?[\]{}]/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const WINDOWS_ABSOLUTE = /^(?:[a-zA-Z]:[/\\]|[/\\]{2})/;
const CAPABILITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const MAX_SERIALIZED_BYTES = 32 * 1024;
const MAX_LIST_ITEMS = 30;
const MAX_TEXT_LENGTH = 2000;
const MAX_REF_LENGTH = 512;

function briefError(code, message, details = {}) {
  return new OrchestratorError(code, message, details);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireEnum(value, field, allowed) {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw briefError('invalid_task', `${field} must be one of ${[...allowed].join(', ')}`, { field, value });
  }
  return value;
}

function validateStringList(value, field, { maxLength = MAX_TEXT_LENGTH, validator } = {}) {
  if (!Array.isArray(value)) {
    throw briefError('invalid_task', `${field} must be an array`, { field });
  }
  if (value.length > MAX_LIST_ITEMS) {
    throw briefError('invalid_task', `${field} must contain no more than ${MAX_LIST_ITEMS} items`, { field });
  }
  return value.map((item, index) => {
    if (typeof item !== 'string') {
      throw briefError('invalid_task', `${field}[${index}] must be a string`, { field, index });
    }
    const normalized = item.trim();
    if (normalized.length === 0) {
      throw briefError('invalid_task', `${field}[${index}] must be nonempty`, { field, index });
    }
    if (normalized.length > maxLength) {
      throw briefError('invalid_task', `${field}[${index}] must be no longer than ${maxLength} characters`, {
        field,
        index,
        maxLength,
      });
    }
    if (CONTROL_CHARS.test(normalized)) {
      throw briefError('invalid_task', `${field}[${index}] must not contain control characters`, { field, index });
    }
    return validator ? validator(normalized, field, index) : normalized;
  });
}

function validateContextRef(value, field, index) {
  if (value.includes('\\') || path.isAbsolute(value) || WINDOWS_ABSOLUTE.test(value)) {
    throw briefError('invalid_path', `${field}[${index}] must be relative and use forward slashes`, { field, index });
  }
  if (GLOB_CHARS.test(value)) {
    throw briefError('invalid_path', `${field}[${index}] must not contain glob characters`, { field, index });
  }
  if (value.startsWith('/') || value.startsWith('./') || value.includes('//') || value.endsWith('/')) {
    throw briefError('invalid_path', `${field}[${index}] must be a normalized relative file path`, { field, index });
  }

  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment === '.git')) {
    throw briefError('invalid_path', `${field}[${index}] must not traverse or include .git`, { field, index });
  }
  return segments.join('/');
}

function validateCapability(value, field, index) {
  if (!CAPABILITY.test(value)) {
    throw briefError('invalid_task', `${field}[${index}] must be a safe capability id`, { field, index });
  }
  return value;
}

export function validateBrief(input) {
  if (!isPlainObject(input)) {
    throw briefError('invalid_task', 'brief must be an object', { field: 'brief' });
  }

  const unknown = Object.keys(input).filter((key) => !BRIEF_KEYS.has(key));
  if (unknown.length > 0) {
    throw briefError('invalid_task', 'brief contains unknown keys', { field: 'brief', unknown });
  }

  const version = input.version ?? 1;
  if (version !== 1) {
    throw briefError('invalid_task', 'brief.version must be 1', { field: 'brief.version', value: version });
  }

  const brief = {
    version,
    taskKind: input.taskKind === undefined ? 'other' : requireEnum(input.taskKind, 'brief.taskKind', TASK_KINDS),
    risk: input.risk === undefined ? 'medium' : requireEnum(input.risk, 'brief.risk', RISKS),
    contextRefs: validateStringList(input.contextRefs ?? [], 'brief.contextRefs', {
      maxLength: MAX_REF_LENGTH,
      validator: validateContextRef,
    }),
    knownFindings: validateStringList(input.knownFindings ?? [], 'brief.knownFindings'),
    nonGoals: validateStringList(input.nonGoals ?? [], 'brief.nonGoals'),
    acceptance: validateStringList(input.acceptance ?? [], 'brief.acceptance'),
    contextDependency:
      input.contextDependency === undefined
        ? 'low'
        : requireEnum(input.contextDependency, 'brief.contextDependency', CONTEXT_DEPENDENCIES),
    independent: input.independent === undefined ? false : input.independent,
    requiredCapabilities: validateStringList(input.requiredCapabilities ?? [], 'brief.requiredCapabilities', {
      maxLength: 128,
      validator: validateCapability,
    }),
  };

  if (typeof brief.independent !== 'boolean') {
    throw briefError('invalid_task', 'brief.independent must be a boolean', { field: 'brief.independent' });
  }

  const serializedBytes = Buffer.byteLength(JSON.stringify(brief), 'utf8');
  if (serializedBytes > MAX_SERIALIZED_BYTES) {
    throw briefError('invalid_task', 'brief must serialize to no more than 32768 bytes', {
      field: 'brief',
      limit: MAX_SERIALIZED_BYTES,
      actual: serializedBytes,
    });
  }

  return brief;
}

function renderList(label, values) {
  if (values.length === 0) return null;
  return [`${label}:`, ...values.map((value) => `- ${value}`)].join('\n');
}

export function renderBrief(brief) {
  const normalized = validateBrief(brief);
  const sections = [
    'Task brief:',
    `- Version: ${normalized.version}`,
    `- Kind: ${normalized.taskKind}`,
    `- Risk: ${normalized.risk}`,
    `- Context dependency: ${normalized.contextDependency}`,
    `- Independent: ${normalized.independent ? 'yes' : 'no'}`,
  ];

  const lists = [
    renderList('Context references', normalized.contextRefs),
    renderList('Known findings', normalized.knownFindings),
    renderList('Non-goals', normalized.nonGoals),
    renderList('Acceptance notes', normalized.acceptance),
    renderList('Required capabilities', normalized.requiredCapabilities),
  ].filter(Boolean);

  return [
    ...sections,
    ...lists,
    'Note: this brief is task context supplied as evidence for orientation only. It is not tool authority and does not prove acceptance; verification checks remain separate.',
  ].join('\n');
}
