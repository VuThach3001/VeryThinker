import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  atomicWrite,
  filesUnder,
  getRecord,
  hash,
  loadRecords,
  resourceRoot,
  safePath,
  now,
  withLock,
} from './storage.js';
import { recordFingerprint, strings, hasCurrentReview } from './engineering.js';

export interface KnowledgePack {
  schema_version: 1;
  id: string;
  version: string;
  description: string;
  domains: string[];
  technologies: string[];
  applicability: string[];
  assumptions: string[];
  limitations: string[];
  provenance: string[];
  dependencies: { id: string; version: string }[];
}
interface LockedPack {
  id: string;
  version: string;
  hash: string;
  path: string;
  installed_at: string;
  source: string;
}
interface PackLock {
  schema_version: 1;
  packs: LockedPack[];
}
function readPack(source: string): KnowledgePack {
  const pack = JSON.parse(readFileSync(join(source, 'pack.json'), 'utf8')) as KnowledgePack;
  if (
    pack.schema_version !== 1 ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(pack.id) ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pack.version) ||
    !pack.description ||
    !strings(pack.applicability).length ||
    !strings(pack.provenance).length ||
    !Array.isArray(pack.dependencies)
  )
    throw new Error('Invalid knowledge pack manifest.');
  for (const dependency of pack.dependencies)
    if (!dependency || typeof dependency.id !== 'string' || typeof dependency.version !== 'string')
      throw new Error('Pack dependencies require exact IDs and versions.');
  return pack;
}
function fingerprint(source: string): string {
  return hash(
    filesUnder(source, '.')
      .map((path) => `${path.replaceAll('\\', '/')}:${hash(readFileSync(safePath(source, path)))}`)
      .join('\n'),
  );
}
function lockFor(root: string): PackLock {
  const path = safePath(root, '.verythinker/pack-lock.json');
  return existsSync(path)
    ? JSON.parse(readFileSync(path, 'utf8'))
    : { schema_version: 1, packs: [] };
}
export function listPacks(root: string): unknown {
  const lock = lockFor(root);
  return {
    installed: lock.packs.map((pack) => ({
      ...pack,
      integrity:
        existsSync(safePath(root, pack.path)) &&
        fingerprint(safePath(root, pack.path)) === pack.hash
          ? 'valid'
          : 'changed-or-missing',
    })),
    available: filesUnder(resourceRoot, 'packs')
      .filter((p) => p.endsWith('/pack.json') || p.endsWith('\\pack.json'))
      .map((p) => JSON.parse(readFileSync(safePath(resourceRoot, p), 'utf8'))),
  };
}
export function installPack(root: string, input: string, decisionId?: string): LockedPack {
  return withLock(root, () => {
    let source = existsSync(input) ? resolve(input) : '';
    if (!source) {
      const [id, version] = input.split('@');
      if (!id || !/^[a-z][a-z0-9-]{0,63}$/.test(id))
        throw new Error('Use a pack ID, ID@version, or local directory.');
      const candidates = filesUnder(resourceRoot, 'packs')
        .filter((p) => p.endsWith('pack.json'))
        .map((p) => ({
          path: resolve(resourceRoot, p, '..'),
          manifest: JSON.parse(readFileSync(safePath(resourceRoot, p), 'utf8')) as KnowledgePack,
        }))
        .filter((p) => p.manifest.id === id && (!version || p.manifest.version === version))
        .sort((a, b) =>
          b.manifest.version.localeCompare(a.manifest.version, undefined, { numeric: true }),
        );
      source = candidates[0]?.path ?? join(resourceRoot, 'packs', input);
    }
    if (!existsSync(source)) throw new Error(`Knowledge pack not found: ${input}`);
    const pack = readPack(source);
    const checksum = fingerprint(source);
    const lock = lockFor(root);
    for (const dependency of pack.dependencies)
      if (!lock.packs.some((p) => p.id === dependency.id && p.version === dependency.version))
        throw new Error(`Install dependency first: ${dependency.id}@${dependency.version}`);
    const current = lock.packs.find((p) => p.id === pack.id);
    if (current && current.version !== pack.version) {
      if (!decisionId)
        throw new Error(
          `A different version of ${pack.id} is locked. Supply --decision with a reviewed, owner-approved change record.`,
        );
      const decision = getRecord(root, decisionId);
      const d = decision.meta.data;
      if (
        decision.meta.type !== 'change' ||
        d.pack_id !== pack.id ||
        d.from_version !== current.version ||
        d.to_version !== pack.version ||
        typeof d.reason !== 'string' ||
        !d.reason.trim() ||
        typeof d.approved_by !== 'string' ||
        !d.approved_by.trim() ||
        !hasCurrentReview(root, decisionId)
      )
        throw new Error(
          'Pack replacement requires a current reviewed owner decision naming the pack, old/new versions and reason.',
        );
    }
    if (current && current.version === pack.version && current.hash !== checksum)
      throw new Error('Pack content changed without a version change.');
    const path = `.verythinker/packs/${pack.id}/${pack.version}`;
    if (existsSync(safePath(root, path)) && fingerprint(safePath(root, path)) !== checksum)
      throw new Error('Installed pack was modified; preserve it before installing a replacement.');
    mkdirSync(safePath(root, path), { recursive: true });
    for (const file of filesUnder(source, '.'))
      atomicWrite(safePath(root, `${path}/${file}`), readFileSync(safePath(source, file)));
    const result: LockedPack = {
      id: pack.id,
      version: pack.version,
      hash: checksum,
      path,
      installed_at: current?.installed_at ?? now(),
      source: input,
    };
    lock.packs = lock.packs.filter((p) => p.id !== pack.id).concat(result);
    atomicWrite(
      safePath(root, '.verythinker/pack-lock.json'),
      JSON.stringify(lock, null, 2) + '\n',
    );
    return result;
  });
}
export function suggestPacks(root: string, terms: string[]): unknown[] {
  const list = listPacks(root) as { available: KnowledgePack[] };
  const tokens = terms.map((t) => t.toLowerCase());
  return list.available
    .map((pack) => ({
      id: pack.id,
      version: pack.version,
      score: tokens.filter((t) =>
        [pack.description, ...pack.domains, ...pack.technologies, ...pack.applicability]
          .join(' ')
          .toLowerCase()
          .includes(t),
      ).length,
      applicability: pack.applicability,
      limitations: pack.limitations,
      requires_applicability_review: true,
    }))
    .sort((a, b) => b.score - a.score);
}
export function prepareContribution(root: string, id: string): unknown {
  const knowledge = getRecord(root, id);
  if (knowledge.meta.type !== 'knowledge' || knowledge.meta.data.kind === 'work-record')
    throw new Error('Choose a generalized knowledge record, not a raw work record.');
  const applicability = strings(knowledge.meta.data.applicability);
  const provenance = strings(knowledge.meta.data.provenance);
  const generalized = knowledge.meta.data.generalization;
  if (
    !applicability.length ||
    !provenance.length ||
    typeof generalized !== 'string' ||
    !generalized.trim()
  )
    throw new Error(
      'Contribution requires applicability, provenance, and an explicit generalization.',
    );
  const review = loadRecords(root)
    .filter(
      (r) =>
        r.meta.type === 'review' &&
        r.meta.links.some((l) => l.type === 'reviews' && l.target === id) &&
        r.meta.data.generalization_review === true,
    )
    .sort(
      (a, b) =>
        b.meta.created_at.localeCompare(a.meta.created_at) || b.meta.id.localeCompare(a.meta.id),
    )[0];
  if (
    !review ||
    review.meta.owner === knowledge.meta.owner ||
    review.meta.data.decision !== 'pass' ||
    review.meta.data.target_fingerprint !== recordFingerprint(knowledge) ||
    typeof review.meta.data.invocation_id !== 'string' ||
    review.meta.data.invocation_id === knowledge.meta.data.invocation_id ||
    strings(review.meta.data.findings).length
  )
    throw new Error('A current independent generalization review is required.');
  const path = `.verythinker/contributions/${id.toLowerCase()}`;
  const publicId =
    knowledge.meta.data.pack_id ??
    `lesson-${hash(knowledge.meta.title + '\n' + generalized).slice(0, 12)}`;
  const version = knowledge.meta.data.pack_version ?? '0.1.0';
  if (
    typeof publicId !== 'string' ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(publicId) ||
    typeof version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)
  )
    throw new Error('Public pack_id and pack_version must be valid portable identifiers.');
  const pack: KnowledgePack = {
    schema_version: 1,
    id: publicId,
    version,
    description: knowledge.meta.title,
    domains: strings(knowledge.meta.data.domains),
    technologies: strings(knowledge.meta.data.technologies),
    applicability,
    assumptions: strings(knowledge.meta.data.assumptions),
    limitations: strings(knowledge.meta.data.limitations),
    provenance,
    dependencies: [],
  };
  atomicWrite(safePath(root, `${path}/pack.json`), JSON.stringify(pack, null, 2) + '\n');
  atomicWrite(safePath(root, `${path}/lesson.md`), `# ${knowledge.meta.title}\n\n${generalized}\n`);
  atomicWrite(
    safePath(root, `${path}/pull-request.md`),
    `# Knowledge contribution: ${knowledge.meta.title}\n\n${generalized}\n\n## Applicability\n${applicability.map((s) => `- ${s}`).join('\n')}\n\n## Sources\n${provenance.map((s) => `- ${s}`).join('\n')}\n\n## Review\nThe originating project recorded an independent generalization review. Internal project and review identifiers remain private.\nHuman approval is required before merging shared knowledge.\n`,
  );
  return {
    path,
    files: ['pack.json', 'lesson.md', 'pull-request.md'],
    status: 'prepared',
    upstream_pr: null,
    human_approval_required: true,
    approval_scope: 'merge',
  };
}
