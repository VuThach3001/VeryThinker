import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { atomicWrite, getRecord, hash, safePath, withOperationLock } from './storage.js';
import { prepareContribution } from './packs.js';

type GitHubRequest = (method: string, endpoint: string, body?: unknown) => any;
interface SubmissionState {
  schema_version: 1;
  operation_id: string;
  repository: string;
  branch: string;
  content_hash: string;
  status: 'planned' | 'tree-created' | 'commit-created' | 'branch-created' | 'draft-pr-created';
  upstream_pr: string | null;
  human_approval_required: true;
  approval_scope: 'merge';
  base_branch?: string;
  base_commit?: string;
  base_tree?: string;
  tree?: string;
  commit?: string;
}
function githubRequest(method: string, endpoint: string, body?: unknown): any {
  const result = spawnSync(
    'gh',
    ['api', '--method', method, endpoint, ...(body ? ['--input', '-'] : [])],
    {
      shell: false,
      encoding: 'utf8',
      input: body ? JSON.stringify(body) : undefined,
      windowsHide: true,
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(`GitHub request failed: ${result.error?.message ?? result.stderr.trim()}`);
  return JSON.parse(result.stdout);
}

/** Explicit submission creates a draft PR; it never merges or pushes project records. */
export function submitContribution(
  root: string,
  id: string,
  repository: string,
  request: GitHubRequest = githubRequest,
): unknown {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new Error('Upstream must be an explicit owner/repository name.');
  // Resolve the authoritative ID before constructing a portable lock key.
  const candidate = getRecord(root, id);
  return withOperationLock(root, `contribution-${candidate.meta.id}`, () =>
    submitClaimedContribution(root, candidate.meta.id, repository, request),
  );
}

function submitClaimedContribution(
  root: string,
  id: string,
  repository: string,
  request: GitHubRequest,
): unknown {
  const prepared = prepareContribution(root, id) as { path: string; files: string[] };
  const pack = JSON.parse(readFileSync(safePath(root, `${prepared.path}/pack.json`), 'utf8'));
  const lesson = readFileSync(safePath(root, `${prepared.path}/lesson.md`), 'utf8');
  const body = readFileSync(safePath(root, `${prepared.path}/pull-request.md`), 'utf8');
  const content_hash = hash(JSON.stringify(pack) + lesson);
  const output = safePath(root, `${prepared.path}/submission.json`);
  const prior = existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : null;
  if (prior && (prior.repository !== repository || prior.content_hash !== content_hash))
    throw new Error(
      'Existing submission belongs to different content or upstream. Preserve it and create a new reviewed knowledge candidate.',
    );
  if (
    prior &&
    (typeof prior.branch !== 'string' ||
      !prior.branch.startsWith('codex/knowledge-') ||
      !['planned', 'tree-created', 'commit-created', 'branch-created', 'draft-pr-created'].includes(
        prior.status,
      ))
  )
    throw new Error('Submission state is malformed; inspect it before publication recovery.');
  const operationId = prior?.operation_id ?? randomUUID();
  const state: SubmissionState = {
    schema_version: 1,
    operation_id: operationId,
    repository,
    branch: `codex/knowledge-${pack.id}-${operationId.slice(0, 8)}`,
    content_hash,
    status: 'planned',
    upstream_pr: null,
    ...prior,
    human_approval_required: true,
    approval_scope: 'merge',
  };
  const persist = () => atomicWrite(output, JSON.stringify(state, null, 2) + '\n');
  // Claim a stable operation and branch before any remote mutation. Every retry
  // re-reads this state under the same candidate lock, including after a crash.
  persist();
  if (state.upstream_pr) return state;
  const repo = request('GET', `repos/${repository}`);
  if (typeof repo.default_branch !== 'string') throw new Error('Upstream has no default branch.');
  const baseBranch: string = state.base_branch ?? repo.default_branch;
  state.base_branch = baseBranch;
  persist();
  if (state.status !== 'branch-created') {
    if (!state.commit) {
      if (!state.base_commit || !state.base_tree) {
        const reference = request(
          'GET',
          `repos/${repository}/git/ref/heads/${encodeURIComponent(baseBranch)}`,
        );
        const base = request('GET', `repos/${repository}/git/commits/${reference.object.sha}`);
        state.base_commit = base.sha;
        state.base_tree = base.tree.sha;
        persist();
      }
      if (!state.tree) {
        const prefix = `resources/packs/${pack.id}/${pack.version}`;
        const tree = request('POST', `repos/${repository}/git/trees`, {
          base_tree: state.base_tree,
          tree: [
            {
              path: `${prefix}/pack.json`,
              mode: '100644',
              type: 'blob',
              content: JSON.stringify(pack, null, 2) + '\n',
            },
            { path: `${prefix}/lesson.md`, mode: '100644', type: 'blob', content: lesson },
          ],
        });
        if (typeof tree.sha !== 'string' || !tree.sha)
          throw new Error('GitHub did not return a tree identity.');
        state.tree = tree.sha;
        state.status = 'tree-created';
        persist();
      }
      const commit = request('POST', `repos/${repository}/git/commits`, {
        message: `Add reviewed knowledge pack ${pack.id}@${pack.version}`,
        tree: state.tree,
        parents: [state.base_commit],
      });
      if (typeof commit.sha !== 'string' || !commit.sha)
        throw new Error('GitHub did not return a commit identity.');
      state.commit = commit.sha;
      state.status = 'commit-created';
      persist();
    }
    let branchExists = false;
    // A prior commit may have been followed by a successful remote ref creation
    // whose response or local checkpoint was lost. Recover the same branch.
    if (prior?.commit) {
      try {
        const reference = request(
          'GET',
          `repos/${repository}/git/ref/heads/${encodeURIComponent(state.branch)}`,
        );
        if (typeof reference.object?.sha === 'string') {
          if (reference.object.sha !== state.commit)
            throw new Error('Persisted publication branch points to a different commit.');
          branchExists = true;
        }
      } catch (error) {
        if ((error as { status?: number }).status !== 404 && !/\bHTTP\s*404\b/i.test(String(error)))
          throw error;
      }
    }
    if (!branchExists)
      request('POST', `repos/${repository}/git/refs`, {
        ref: `refs/heads/${state.branch}`,
        sha: state.commit,
      });
    state.status = 'branch-created';
    persist();
  }
  const existing = prior
    ? request(
        'GET',
        `repos/${repository}/pulls?state=all&head=${encodeURIComponent(repository.split('/')[0] + ':' + state.branch)}`,
      )
    : [];
  let pr = Array.isArray(existing) ? existing.find((item) => item?.html_url) : undefined;
  if (!pr) {
    // Remote preparation may be slow. Recheck the current independent review
    // and public content immediately before making the proposal visible as a PR.
    const current = prepareContribution(root, id) as { path: string };
    const currentPack = JSON.parse(
      readFileSync(safePath(root, `${current.path}/pack.json`), 'utf8'),
    );
    const currentLesson = readFileSync(safePath(root, `${current.path}/lesson.md`), 'utf8');
    if (hash(JSON.stringify(currentPack) + currentLesson) !== content_hash)
      throw new Error(
        'Candidate changed during publication. Preserve its branch and create a new reviewed candidate.',
      );
    pr = request('POST', `repos/${repository}/pulls`, {
      title: `Knowledge: ${pack.description}`,
      body,
      head: state.branch,
      base: baseBranch,
      draft: true,
    });
  }
  if (typeof pr.html_url !== 'string')
    throw new Error(
      'GitHub did not return a pull request URL. Inspect the persisted submission state.',
    );
  state.upstream_pr = pr.html_url;
  state.status = 'draft-pr-created';
  persist();
  return state;
}
