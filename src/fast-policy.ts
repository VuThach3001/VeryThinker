import { existsSync, readFileSync, realpathSync, statSync, lstatSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { resolveRecipe } from './recipes.js';
import { getRecord, hash, loadRecords, safePath } from './storage.js';

export type ExecutionPolicy = 'fast' | 'standard' | 'extended';
export type PolicyRequest = 'auto' | ExecutionPolicy;
export interface FastSelection {
  schema_version: 1;
  mode: 'fast';
  workflow_id: string;
  request_sha256: string;
  binding_id: string;
  binding_sha256: string;
  configuration_sha256: string;
  recipe: { id: string; version: string; integrity: string };
  parameters: Record<string, unknown>;
  editable_paths: string[];
  protected_inputs: Record<string, string>;
  baseline_inputs: Record<string, string>;
  selection_fingerprint: string;
}
export interface SelectPolicyInput {
  workflow_id: string;
  requirement?: string;
  requirements?: string[];
  policy?: PolicyRequest;
}
export interface PolicyDecision {
  mode: ExecutionPolicy;
  reason_codes: string[];
  fast?: FastSelection;
}

type Binding = {
  id: string;
  requirement: string;
  classification: 'familiar' | 'low-risk' | 'warm';
  recipe_id: string;
  recipe_version: string;
  parameters: Record<string, unknown>;
  editable_paths: string[];
  protected_input_paths: string[];
  risk_flags: { security: false; safety: false; interfaces: false; dependencies: false; environment: false };
};
const bindingFile = '.verythinker/fast-bindings.json';
const policyInputs = [
  '.verythinker/config.json',
  '.verythinker/routing.json',
  '.verythinker/tools.json',
];
const maxEditablePaths = 5;
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}
function digest(value: unknown): string { return hash(canonical(value)); }
function readBytes(root: string, path: string): Buffer | undefined {
  const absolute = safePath(root, path);
  return existsSync(absolute) ? readFileSync(absolute) : undefined;
}
function projectPolicyHash(root: string, bindingsHash: string): string {
  const inputs = Object.fromEntries(policyInputs.map((path) => [path, readBytes(root, path)?.toString('base64') ?? null]));
  return digest({ inputs, bindingsHash });
}
function requestIdentity(input: SelectPolicyInput): string {
  const exact = input.requirement ?? (input.requirements?.length === 1 ? input.requirements[0] : undefined);
  return digest({ requirement: exact ?? null });
}
function workflowRequirement(root: string, workflowId: string): string | undefined {
  const exists = loadRecords(root).some((record) => record.meta.id === workflowId);
  if (!exists) return undefined;
  const workflow = getRecord(root, workflowId);
  if (workflow.meta.type !== 'knowledge' || workflow.meta.data.kind !== 'manager-workflow')
    throw new Error('Fast execution requires an authoritative manager workflow.');
  const originals = workflow.meta.data.original_requirements;
  const original = workflow.meta.data.original_requirement;
  if (!Array.isArray(originals) || originals.length !== 1 || typeof original !== 'string' || originals[0] !== original)
    throw new Error('Fast execution requires exactly one unchanged original workflow requirement.');
  return original;
}
function visibleExistingFile(root: string, path: unknown): string {
  if (typeof path !== 'string' || !path || path.includes('\\') || isAbsolute(path) || path.split('/').some((p) => !p || p === '.' || p === '..'))
    throw new Error('Fast policy paths must be canonical project-relative forward-slash paths.');
  const target = safePath(root, path);
  const canonicalPath = relative(resolve(root), target).replaceAll('\\', '/');
  if (canonicalPath !== path || canonicalPath.startsWith('.') || canonicalPath.split('/').some((part) => !/^[a-zA-Z0-9_.-]+$/.test(part)))
    throw new Error(`Fast policy path is protected or non-canonical: ${path}`);
  if (canonicalPath === '.verythinker' || canonicalPath.startsWith('.verythinker/') || canonicalPath.split('/').some((part) => ['private', 'cache', 'records', 'runs'].includes(part.toLowerCase())))
    throw new Error(`Fast policy cannot include protected project state: ${path}`);
  if (!existsSync(target) || !statSync(target).isFile()) throw new Error(`Fast policy path must name an existing file: ${path}`);
  let cursor = resolve(root);
  for (const part of path.split('/')) {
    cursor = resolve(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) throw new Error(`Fast policy cannot use a symbolic-link or junction alias: ${path}`);
  }
  const physicalRoot = realpathSync(root), physical = realpathSync(target), rel = relative(physicalRoot, physical);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Fast policy path follows a link outside the project: ${path}`);
  return canonicalPath;
}
function validateParameters(root: string, id: string, p: Record<string, unknown>): void {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('Fast recipe parameters must be an object.');
  const string = (k: string) => typeof p[k] === 'string' && !!p[k];
  const visibleDirectory = (value: unknown) => {
    if (typeof value !== 'string' || !value || value.includes('\\')) throw new Error('Fast recipe output_dir must be a canonical visible project path.');
    const target = safePath(root, value), path = relative(resolve(root), target).replaceAll('\\', '/');
    if (path !== value || path.startsWith('.') || !path.split('/').every((part) => /^[a-zA-Z0-9_.-]+$/.test(part))) throw new Error('Fast recipe output_dir must be a canonical visible project path.');
  };
  if (id === 'software-config-persistence') {
    const fields = p.fields as Record<string, { type?: string; default?: unknown; min?: number; max?: number; enum?: unknown[] }>;
    if (!string('output_dir') || !Number.isSafeInteger(p.schema_version) || Number(p.schema_version) < 1 || !fields || Array.isArray(fields) || !Object.keys(fields).length) throw new Error('Fast software recipe parameters are invalid.');
    visibleDirectory(p.output_dir);
    for (const [name, field] of Object.entries(fields)) {
      const valueType = field?.type === 'integer' || field?.type === 'number' ? 'number' : field?.type;
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name) || ['schemaVersion','__proto__','constructor','prototype'].includes(name) || !field || !['integer','number','string','boolean'].includes(String(field.type)) || typeof field.default !== valueType || (field.type === 'integer' && !Number.isSafeInteger(field.default))) throw new Error(`Fast software recipe field is invalid: ${name}`);
      if (field.min !== undefined && (!Number.isFinite(field.min) || !['integer','number'].includes(String(field.type)) || (field.type === 'integer' && !Number.isSafeInteger(field.min)))) throw new Error(`Fast software recipe minimum is invalid: ${name}`);
      if (field.max !== undefined && (!Number.isFinite(field.max) || !['integer','number'].includes(String(field.type)) || (field.type === 'integer' && !Number.isSafeInteger(field.max)))) throw new Error(`Fast software recipe maximum is invalid: ${name}`);
      if ((field.min !== undefined && field.max !== undefined && field.min > field.max) || (field.min !== undefined && Number(field.default) < field.min) || (field.max !== undefined && Number(field.default) > field.max)) throw new Error(`Fast software recipe default is outside its bounds: ${name}`);
      if (field.enum !== undefined && (!Array.isArray(field.enum) || !field.enum.length || !field.enum.includes(field.default) || field.enum.some((item) => typeof item !== typeof field.default))) throw new Error(`Fast software recipe enum is invalid: ${name}`);
    }
  } else if (id === 'embedded-hysteresis-load-control') {
    const n = ['adc_max','fault_low','off_threshold','on_threshold','fault_high'].map((k) => p[k]);
    const vals = ['supply_v','load_ohm','on_ohm','off_ohm','tolerance'].map((k) => p[k]);
    if (!string('output_dir') || !n.every(Number.isSafeInteger) || Number(n[0]) > 65535 || !(0 <= Number(n[1]) && Number(n[1]) < Number(n[2]) && Number(n[2]) < Number(n[3]) && Number(n[3]) < Number(n[4]) && Number(n[4]) <= Number(n[0])) || !vals.every((x) => typeof x === 'number' && Number.isFinite(x) && x > 0) || Number(p.off_ohm) <= Number(p.on_ohm) || Number(p.tolerance) > 0.01) throw new Error('Fast embedded recipe parameters are invalid.');
  } else throw new Error('Fast policy recipe is not supported.');
}
function parseBindings(bytes: Buffer): Binding[] {
  const data = JSON.parse(bytes.toString('utf8')) as { schema_version?: number; bindings?: Binding[] };
  if (data.schema_version !== 1 || !Array.isArray(data.bindings)) throw new Error('Fast bindings schema is invalid.');
  const ids = new Set<string>(), reqs = new Set<string>();
  for (const b of data.bindings) {
    if (!b || typeof b.id !== 'string' || !b.id || ids.has(b.id) || typeof b.requirement !== 'string' || !b.requirement || reqs.has(b.requirement)) throw new Error('Fast bindings contain a duplicate or invalid identity/requirement.');
    ids.add(b.id); reqs.add(b.requirement);
    if (!['familiar','low-risk','warm'].includes(b.classification) || !b.recipe_id || !b.recipe_version || !Array.isArray(b.editable_paths) || !b.editable_paths.length || b.editable_paths.length > maxEditablePaths || !Array.isArray(b.protected_input_paths) || !b.protected_input_paths.length || !b.parameters || typeof b.parameters !== 'object') throw new Error(`Fast binding ${b.id} is incomplete.`);
    const flags = b.risk_flags as Record<string, unknown>;
    if (!flags || ['security','safety','interfaces','dependencies','environment'].some((key) => flags[key] !== false) || Object.keys(flags).length !== 5) throw new Error(`Fast binding ${b.id} has ineligible risk flags.`);
  }
  return data.bindings;
}
function fingerprint(selection: Omit<FastSelection, 'selection_fingerprint'>): string { return digest(selection); }

export function selectExecutionPolicy(root: string, input: SelectPolicyInput): PolicyDecision {
  const requested = input.policy ?? 'auto';
  if (!['auto','fast','standard','extended'].includes(requested)) throw new Error('Unknown execution policy request.');
  if (!input.workflow_id) throw new Error('A workflow identity is required for policy selection.');
  if (requested === 'standard' || requested === 'extended') return { mode: requested, reason_codes: [`explicit_${requested}`] };
  let bytes: Buffer | undefined;
  try { bytes = readBytes(root, bindingFile); }
  catch (error) {
    if (requested === 'fast') throw new Error(`Explicit fast policy is invalid: bindings cannot be read (${error instanceof Error ? error.message : String(error)}).`);
    return { mode: 'standard', reason_codes: ['unreadable_fast_bindings'] };
  }
  if (!bytes) {
    if (requested === 'fast') throw new Error('Explicit fast policy is unavailable: project has no fast bindings.');
    return { mode: 'standard', reason_codes: ['no_fast_bindings'] };
  }
  let bindings: Binding[];
  try { bindings = parseBindings(bytes); } catch (error) { if (requested === 'fast') throw error; return { mode: 'standard', reason_codes: ['invalid_fast_bindings'] }; }
  const requirement = input.requirement ?? (input.requirements?.length === 1 ? input.requirements[0] : undefined);
  const matches = requirement === undefined ? [] : bindings.filter((b) => b.requirement === requirement);
  if (matches.length !== 1) {
    if (requested === 'fast') throw new Error(matches.length ? 'Explicit fast policy is ambiguous.' : 'Explicit fast policy has no exact requirement binding.');
    return { mode: 'standard', reason_codes: [matches.length ? 'ambiguous_binding' : 'no_exact_binding'] };
  }
  const binding = matches[0]!;
  try {
    const original = workflowRequirement(root, input.workflow_id);
    if (original === undefined || original !== requirement) throw new Error('Fast policy request does not match the authoritative workflow original requirement.');
    const descriptor = resolveRecipe(binding.recipe_id, binding.recipe_version);
    validateParameters(root, binding.recipe_id, binding.parameters);
    const editable = [...new Set(binding.editable_paths.map((p) => visibleExistingFile(root, p)))].sort();
    if (editable.length !== binding.editable_paths.length) throw new Error('Fast editable paths contain duplicates.');
    const protectedPaths = [...new Set(binding.protected_input_paths.map((p) => visibleExistingFile(root, p)))].sort();
    if (protectedPaths.some((p) => editable.includes(p))) throw new Error('Protected verification inputs cannot be editable.');
    const protected_inputs = Object.fromEntries(protectedPaths.map((p) => [p, hash(readFileSync(safePath(root, p)))]));
    const baseline_inputs = Object.fromEntries(editable.map((p) => [p, hash(readFileSync(safePath(root, p)))]));
    const core = { schema_version: 1 as const, mode: 'fast' as const, workflow_id: input.workflow_id, request_sha256: requestIdentity(input), binding_id: binding.id, binding_sha256: hash(bytes), configuration_sha256: projectPolicyHash(root, hash(bytes)), recipe: { id: descriptor.id, version: descriptor.version, integrity: descriptor.hash }, parameters: JSON.parse(JSON.stringify(binding.parameters)) as Record<string, unknown>, editable_paths: editable, protected_inputs, baseline_inputs };
    const fast = { ...core, selection_fingerprint: fingerprint(core) };
    return { mode: 'fast', reason_codes: [`eligible_${binding.classification}`], fast };
  } catch (error) {
    if (requested === 'fast') throw new Error(`Explicit fast policy is invalid: ${error instanceof Error ? error.message : String(error)}`);
    return { mode: 'standard', reason_codes: ['ineligible_binding'] };
  }
}

export function validateFastSelection(root: string, selection: FastSelection, options: { baseline?: boolean } = {}): void {
  if (!selection || selection.schema_version !== 1 || selection.mode !== 'fast') throw new Error('Fast selection schema is invalid.');
  const { selection_fingerprint, ...core } = selection;
  if (fingerprint(core) !== selection_fingerprint) throw new Error('Fast selection fingerprint is invalid.');
  const bytes = readBytes(root, bindingFile);
  if (!bytes || hash(bytes) !== selection.binding_sha256) throw new Error('Fast bindings changed after policy selection.');
  const binding = parseBindings(bytes).find((item) => item.id === selection.binding_id);
  if (!binding || digest({ requirement: binding.requirement }) !== selection.request_sha256) throw new Error('Fast request identity does not match its exact requirement binding.');
  const original = workflowRequirement(root, selection.workflow_id);
  if (original === undefined || original !== binding.requirement) throw new Error('Fast selection does not match the authoritative workflow original requirement.');
  if (projectPolicyHash(root, hash(bytes)) !== selection.configuration_sha256) throw new Error('Fast policy configuration changed after selection.');
  const descriptor = resolveRecipe(selection.recipe.id, selection.recipe.version);
  if (selection.recipe.id !== binding.recipe_id || selection.recipe.version !== binding.recipe_version || descriptor.hash !== selection.recipe.integrity) throw new Error('Fast recipe identity or integrity differs from its binding.');
  validateParameters(root, binding.recipe_id, binding.parameters);
  if (canonical(selection.parameters) !== canonical(binding.parameters)) throw new Error('Fast selection parameters differ from the validated binding.');
  const expectedEditable = [...new Set(binding.editable_paths.map((path) => visibleExistingFile(root, path)))].sort();
  const selectedEditable = selection.editable_paths.map((path) => visibleExistingFile(root, path)).sort();
  if (canonical(selectedEditable) !== canonical(expectedEditable) || new Set(selectedEditable).size !== selectedEditable.length) throw new Error('Fast editable paths differ from the binding scope.');
  const expectedProtectedPaths = [...new Set(binding.protected_input_paths.map((path) => visibleExistingFile(root, path)))].sort();
  if (canonical(Object.keys(selection.protected_inputs).sort()) !== canonical(expectedProtectedPaths)) throw new Error('Fast protected input paths differ from the binding.');
  if (canonical(Object.keys(selection.baseline_inputs).sort()) !== canonical(expectedEditable) || Object.values(selection.baseline_inputs).some((value) => !/^[a-f0-9]{64}$/.test(value))) throw new Error('Fast planning baselines do not match the editable scope.');
  for (const [path, expected] of Object.entries(selection.protected_inputs)) {
    const canonicalPath = visibleExistingFile(root, path);
    if (hash(readFileSync(safePath(root, canonicalPath))) !== expected) throw new Error(`Protected fast input changed: ${path}`);
  }
  if (options.baseline) for (const [path, expected] of Object.entries(selection.baseline_inputs)) {
    const canonicalPath = visibleExistingFile(root, path);
    if (hash(readFileSync(safePath(root, canonicalPath))) !== expected) throw new Error(`Fast planning baseline changed: ${path}`);
  }
}
