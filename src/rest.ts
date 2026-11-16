// GitHub REST API v3 for the forge, per the kit's endpoint contract.
// Written from scratch for this entry.

import {
  DEFAULT_BRANCH,
  buildCommit,
  hashObject,
  ident,
  isAncestor,
  parseCommit,
  parseTree,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import {
  b64decode,
  b64encode,
  bool,
  errResp,
  isRecord,
  isoNow,
  jsonResp,
  jsonText,
  notFound,
  num,
  pageOf,
  paginate,
  str,
  type ReqCtx,
  type Resp,
} from './http.ts';

// ---------------------------------------------------------------- shapes

function userJson(store: Store, login: string): Record<string, unknown> {
  return {
    login,
    id: 1000,
    node_id: store.globalId('User', login),
    avatar_url: '',
    gravatar_id: '',
    url: `/api/v3/users/${login}`,
    html_url: `https://example.invalid/${login}`,
    type: 'User',
    site_admin: login === store.viewer(),
  };
}

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const owner = repo.owner === '' ? store.viewer() : repo.owner;
  return {
    id: repo.id,
    node_id: store.globalId('Repository', `${owner}/${repo.name}`),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: userJson(store, owner),
    private: repo.private,
    html_url: `https://example.invalid/${owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    git_url: `git://example.invalid/${owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${owner}/${repo.name}.git`,
    clone_url: `https://example.invalid/${owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: false,
    has_downloads: true,
    has_wiki: false,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  const owner = repo.owner === '' ? store.viewer() : repo.owner;
  return {
    id: issue.id,
    node_id: store.globalId('Issue', `${owner}/${repo.name}#${issue.number}`),
    url: `/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${owner}/${repo.name}`,
    html_url: `https://example.invalid/${owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: userJson(store, issue.userLogin),
    labels: issue.labels.map((l) => ({ id: 1, node_id: store.globalId('Label', `${owner}/${repo.name}:${l.name}`), name: l.name, color: l.color, description: '', default: false, url: `/api/v3/repos/${owner}/${repo.name}/labels/${encodeURIComponent(l.name)}` })),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    author_association: 'OWNER',
    state_reason: issue.state === 'closed' ? 'completed' : null,
  };
}

function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const owner = repo.owner === '' ? store.viewer() : repo.owner;
  const headRepo = repoJson(store, repo);
  return {
    id: pull.id,
    node_id: store.globalId('PullRequest', `${owner}/${repo.name}#${pull.number}`),
    url: `/api/v3/repos/${owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://example.invalid/${owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    draft: pull.draft,
    user: userJson(store, pull.userLogin),
    head: { label: `${owner}:${pull.headRef}`, ref: pull.headRef, sha: pull.headSha, user: userJson(store, owner), repo: headRepo },
    base: { label: `${owner}:${pull.baseRef}`, ref: pull.baseRef, sha: pull.baseSha, user: userJson(store, owner), repo: headRepo },
    merged: pull.merged,
    mergeable: pull.mergeable,
    mergeable_state: pull.mergeable ? 'clean' : 'dirty',
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    comments: 0,
    review_comments: 0,
    commits: 1,
    additions: pull.files.reduce((n, f) => n + f.additions, 0),
    deletions: pull.files.reduce((n, f) => n + f.deletions, 0),
    changed_files: pull.files.length,
    author_association: 'OWNER',
  };
}

function commitJson(store: Store, repo: Repo, sha: string): Record<string, unknown> | null {
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'commit') return null;
  const c = parseCommit(obj.data);
  const owner = repo.owner === '' ? store.viewer() : repo.owner;
  const authorLine = c.author;
  const name = authorLine.split(' <')[0] ?? owner;
  const email = authorLine.includes('<') ? (authorLine.split('<')[1]?.split('>')[0] ?? '') : '';
  const ts = authorLine.trim().split(' ').slice(-2, -1)[0];
  const date = ts ? new Date(Number(ts) * 1000).toISOString() : repo.createdAt;
  return {
    sha,
    node_id: store.globalId('Commit', sha),
    url: `/api/v3/repos/${owner}/${repo.name}/commits/${sha}`,
    html_url: `https://example.invalid/${owner}/${repo.name}/commit/${sha}`,
    commit: {
      author: { name, email, date },
      committer: { name, email, date },
      message: c.message,
      tree: { sha: c.tree, url: `/api/v3/repos/${owner}/${repo.name}/git/trees/${c.tree}` },
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    author: { login: name, id: 1000, type: 'User' },
    committer: { login: name, id: 1000, type: 'User' },
    parents: c.parents.map((p) => ({ sha: p, url: `/api/v3/repos/${owner}/${repo.name}/commits/${p}`, html_url: `https://example.invalid/${owner}/${repo.name}/commit/${p}` })),
  };
}

// ---------------------------------------------------------------- helpers

function resolveRepo(ctx: ReqCtx, owner: string, name: string): Repo | null {
  const store = ctx.store;
  // Bind the viewer on the first owner-bearing request; a different owner is foreign.
  if (store.viewerLogin === null) store.bindViewer(owner);
  if (owner !== store.viewerLogin) return null;
  return store.getRepo(owner, name) ?? null;
}

function cacheIssue(store: Store, repo: Repo, issue: Issue): void {
  issue.cachedJson = JSON.stringify(issueJson(store, repo, issue));
}

/** Create a commit on `branch` that sets `path` to `content` (or deletes it when content is null). */
function writeFileCommit(
  ctx: ReqCtx,
  repo: Repo,
  branch: string,
  path: string,
  content: string | null,
  message: string,
): { commitSha: string; contentSha: string | null } {
  const store = ctx.store;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  // Copy: flattenCommit returns the repo's memoized map, which must never be mutated.
  const files = new Map(tip ? store.flattenCommit(repo, tip) : []);
  let contentSha: string | null = null;
  if (content === null) {
    files.delete(path);
  } else {
    contentSha = store.putObject(repo, 'blob', Buffer.from(content, 'utf8'));
    files.set(path, { oid: contentSha, mode: '100644' });
  }
  const commitSha = store.commitFiles(repo, branch, files, message, store.viewer());
  return { commitSha, contentSha };
}

function branchTip(repo: Repo, ref: string): string | null {
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`)!;
  if (repo.refs.has(ref)) return repo.refs.get(ref)!;
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
  return null;
}

// ---------------------------------------------------------------- router

export function handleRest(ctx: ReqCtx): Resp | null {
  const s = ctx.segments; // after /api/v3
  const m = ctx.method;
  const store = ctx.store;

  // GET /api/v3/ root
  if (s.length === 0) {
    if (m !== 'GET') return notFound();
    return jsonResp(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta
  if (s.length === 1 && s[0] === 'meta') {
    if (m !== 'GET') return notFound();
    return jsonResp(200, { installed_version: '1.0.0', verifiable_password_authentication: true, ssh_key_fingerprints: {}, hooks: [], github_enterprise: false });
  }

  // GET /api/v3/user
  if (s.length === 1 && s[0] === 'user') {
    if (m !== 'GET') return notFound();
    return jsonResp(200, userJson(store, store.viewer()));
  }

  // GET /api/v3/rate_limit
  if (s.length === 1 && s[0] === 'rate_limit') {
    return jsonResp(200, { resources: { core: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600 } }, rate: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600 } });
  }

  // POST /api/v3/user/repos ; GET /api/v3/user/repos
  if (s.length === 2 && s[0] === 'user' && s[1] === 'repos') {
    if (m === 'POST') return createRepo(ctx);
    if (m === 'GET') {
      const { page, perPage } = pageOf(ctx.query);
      const owner = store.viewerLogin ?? '';
      const repos = owner === '' ? [] : store.listRepos(owner);
      // Repos created before binding live under '' owner; include them too.
      const pending = owner === '' ? [] : store.listRepos('');
      const all = [...repos, ...pending];
      const { pageItems, link } = paginate(all, page, perPage, `${ctx.origin}/api/v3/user/repos`);
      return jsonResp(200, pageItems.map((r) => repoJson(store, r)), link ? { link } : {});
    }
    return notFound();
  }

  // /api/v3/repos/{owner}/{name}[/...]
  if (s.length >= 3 && s[0] === 'repos') {
    return handleRepo(ctx, s.slice(1));
  }

  return null; // unknown route -> JSON 404 by caller
}

function createRepo(ctx: ReqCtx): Resp {
  const store = ctx.store;
  if (ctx.bodyError) return errResp(400, 'Problems parsing JSON');
  const body = isRecord(ctx.body) ? ctx.body : {};
  const name = str(body.name).trim();
  if (name === '') return errResp(422, 'Validation Failed: name is required');
  const owner = store.viewer();
  const existing = store.getRepo(owner, name) ?? (store.viewerLogin === null ? store.getRepo('', name) : undefined);
  if (existing) return errResp(422, 'Repository already exists');
  const repo = store.createRepo(store.viewerLogin ?? '', name, str(body.description), bool(body.private, false));
  return jsonResp(201, repoJson(store, repo));
}

function handleRepo(ctx: ReqCtx, rest: string[]): Resp {
  const store = ctx.store;
  const m = ctx.method;
  const owner = rest[0]!;
  const name = rest[1]!;
  const repo = resolveRepo(ctx, owner, name);
  // Special-case: DELETE of a repo that does not exist is still 404; creation is elsewhere.
  if (!repo) return notFound();

  const tail = rest.slice(2);

  // /repos/{o}/{r}
  if (tail.length === 0) {
    if (m === 'GET') return jsonResp(200, repoJson(store, repo));
    if (m === 'PATCH') {
      if (ctx.bodyError) return errResp(400, 'Problems parsing JSON');
      const body = isRecord(ctx.body) ? ctx.body : {};
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      repo.updatedAt = isoNow();
      return jsonResp(200, repoJson(store, repo));
    }
    if (m === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      return { status: 204, body: '', contentType: 'application/json; charset=utf-8' };
    }
    return notFound();
  }

  // /repos/{o}/{r}/branches[/{branch}]
  if (tail[0] === 'branches') {
    if (tail.length === 1 && m === 'GET') {
      const list = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .map((r) => r.slice('refs/heads/'.length))
        .sort()
        .map((b) => ({ name: b, commit: { sha: repo.refs.get(`refs/heads/${b}`)!, url: `/api/v3/repos/${owner}/${name}/commits/${repo.refs.get(`refs/heads/${b}`)!}` }, protected: false }));
      return jsonResp(200, list);
    }
    if (tail.length === 2 && m === 'GET') {
      const sha = repo.refs.get(`refs/heads/${tail[1]}`);
      if (!sha) return notFound();
      return jsonResp(200, { name: tail[1], commit: { sha, url: `/api/v3/repos/${owner}/${name}/commits/${sha}` }, protected: false });
    }
    return notFound();
  }

  // /repos/{o}/{r}/commits[/{sha}]
  if (tail[0] === 'commits') {
    if (m !== 'GET') return notFound();
    if (tail.length === 2) {
      const c = commitJson(store, repo, tail[1]!);
      return c ? jsonResp(200, c) : notFound();
    }
    const ref = ctx.query.get('sha') ?? repo.defaultBranch;
    const tip = branchTip(repo, ref);
    if (!tip) return jsonResp(200, []);
    const shas = store.listCommits(repo, tip);
    const out: unknown[] = [];
    for (const sha of shas) {
      const c = commitJson(store, repo, sha);
      if (c) out.push(c);
    }
    const { page, perPage } = pageOf(ctx.query);
    const { pageItems, link } = paginate(out, page, perPage, `${ctx.origin}/api/v3/repos/${owner}/${name}/commits`);
    return jsonResp(200, pageItems, link ? { link } : {});
  }

  // /repos/{o}/{r}/git/refs[/...]
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (m === 'POST' && tail.length === 2) {
      if (ctx.bodyError) return errResp(400, 'Problems parsing JSON');
      const body = isRecord(ctx.body) ? ctx.body : {};
      const ref = str(body.ref);
      const sha = str(body.sha);
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) return errResp(422, 'Validation Failed');
      if (repo.refs.has(ref)) return errResp(422, 'Reference already exists');
      if (!repo.objects.has(sha)) return errResp(422, 'Object does not exist');
      repo.refs.set(ref, sha);
      repo.version += 1;
      repo.advCache.clear();
      repo.packCache.clear();
      return jsonResp(201, { ref, node_id: store.globalId('Ref', `${owner}/${name}:${ref}`), url: `/api/v3/repos/${owner}/${name}/git/refs/${ref.replace('refs/', '')}`, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: `/api/v3/repos/${owner}/${name}/git/commits/${sha}` } });
    }
    if (m === 'GET') {
      // /git/refs/heads/{branch} or /git/refs (list)
      const suffix = tail.slice(2).join('/');
      if (suffix === '') {
        const list = sortedRefsOf(repo).map((r) => ({ ref: r.name, node_id: store.globalId('Ref', `${owner}/${name}:${r.name}`), url: `/api/v3/repos/${owner}/${name}/git/refs/${r.name.replace('refs/', '')}`, object: { sha: r.oid, type: repo.objects.get(r.oid)?.type ?? 'commit', url: `/api/v3/repos/${owner}/${name}/git/commits/${r.oid}` } }));
        return jsonResp(200, list);
      }
      const ref = `refs/${suffix}`;
      const sha = repo.refs.get(ref);
      if (!sha) return notFound();
      return jsonResp(200, { ref, node_id: store.globalId('Ref', `${owner}/${name}:${ref}`), url: `/api/v3/repos/${owner}/${name}/git/refs/${suffix}`, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: `/api/v3/repos/${owner}/${name}/git/commits/${sha}` } });
    }
    return notFound();
  }

  // /repos/{o}/{r}/contents/{path...}
  if (tail[0] === 'contents') {
    const filePath = tail.slice(1).map(decodeURIComponent).join('/');
    return handleContents(ctx, repo, filePath);
  }

  // /repos/{o}/{r}/labels
  if (tail[0] === 'labels') {
    if (m === 'GET' && tail.length === 1) {
      return jsonResp(200, [...repo.labels.values()].map((l) => ({ id: 1, node_id: store.globalId('Label', `${owner}/${name}:${l.name}`), name: l.name, color: l.color, description: '', default: false, url: `/api/v3/repos/${owner}/${name}/labels/${encodeURIComponent(l.name)}` })));
    }
    if (m === 'POST' && tail.length === 1) {
      if (ctx.bodyError) return errResp(400, 'Problems parsing JSON');
      const body = isRecord(ctx.body) ? ctx.body : {};
      const lname = str(body.name).trim();
      if (lname === '') return errResp(422, 'Validation Failed: name is required');
      const color = str(body.color, 'ededed').replace(/^#/, '');
      repo.labels.set(lname, { name: lname, color });
      return jsonResp(201, { id: 1, node_id: store.globalId('Label', `${owner}/${name}:${lname}`), name: lname, color, description: str(body.description), default: false, url: `/api/v3/repos/${owner}/${name}/labels/${encodeURIComponent(lname)}` });
    }
    return notFound();
  }

  // /repos/{o}/{r}/issues[/{n}[/comments]]
  if (tail[0] === 'issues') {
    return handleIssues(ctx, repo, tail.slice(1));
  }

  // /repos/{o}/{r}/pulls[/{n}[/files|merge]]
  if (tail[0] === 'pulls') {
    return handlePulls(ctx, repo, tail.slice(1));
  }

  return notFound();
}

function sortedRefsOf(repo: Repo): Array<{ name: string; oid: string }> {
  const out: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : 1));
  return out;
}

// ---------------------------------------------------------------- contents

function handleContents(ctx: ReqCtx, repo: Repo, filePath: string): Resp {
  const store = ctx.store;
  const m = ctx.method;
  const owner = repo.owner === '' ? store.viewer() : repo.owner;
  const refParam = ctx.query.get('ref') ?? repo.defaultBranch;

  if (m === 'GET') {
    const tip = branchTip(repo, refParam);
    if (!tip) return notFound();
    const files = store.flattenCommit(repo, tip);
    // Directory?
    const dirPrefix = filePath === '' ? '' : `${filePath}/`;
    const entries: Array<Record<string, unknown>> = [];
    const seenDirs = new Set<string>();
    for (const [path, v] of files) {
      if (filePath !== '' && !path.startsWith(dirPrefix) && path !== filePath) continue;
      if (path === filePath) {
        const obj = repo.objects.get(v.oid);
        const content = obj ? obj.data.toString('utf8') : '';
        return jsonResp(200, {
          type: 'file',
          encoding: 'base64',
          size: obj ? obj.data.length : 0,
          name: filePath.split('/').pop() ?? filePath,
          path: filePath,
          content: b64encode(content),
          sha: v.oid,
          url: `/api/v3/repos/${owner}/${repo.name}/contents/${filePath}`,
          html_url: `https://example.invalid/${owner}/${repo.name}/blob/${refParam}/${filePath}`,
          git_url: `/api/v3/repos/${owner}/${repo.name}/git/blobs/${v.oid}`,
          download_url: null,
          _links: { self: `/api/v3/repos/${owner}/${repo.name}/contents/${filePath}`, git: `/api/v3/repos/${owner}/${repo.name}/git/blobs/${v.oid}`, html: `https://example.invalid/${owner}/${repo.name}/blob/${refParam}/${filePath}` },
        });
      }
      if (filePath === '') {
        const first = path.split('/')[0]!;
        if (path.includes('/')) {
          if (!seenDirs.has(first)) {
            seenDirs.add(first);
            entries.push({ type: 'dir', name: first, path: first, sha: '', size: 0, url: `/api/v3/repos/${owner}/${repo.name}/contents/${first}`, html_url: '', git_url: '', download_url: null });
          }
        } else {
          entries.push({ type: 'file', name: path, path, sha: v.oid, size: repo.objects.get(v.oid)?.data.length ?? 0, url: `/api/v3/repos/${owner}/${repo.name}/contents/${path}`, html_url: '', git_url: '', download_url: null });
        }
      } else if (path.startsWith(dirPrefix)) {
        const rest = path.slice(dirPrefix.length);
        const first = rest.split('/')[0]!;
        if (rest.includes('/')) {
          if (!seenDirs.has(first)) {
            seenDirs.add(first);
            entries.push({ type: 'dir', name: first, path: `${filePath}/${first}`, sha: '', size: 0, url: `/api/v3/repos/${owner}/${repo.name}/contents/${filePath}/${first}`, html_url: '', git_url: '', download_url: null });
          }
        } else {
          entries.push({ type: 'file', name: rest, path, sha: v.oid, size: repo.objects.get(v.oid)?.data.length ?? 0, url: `/api/v3/repos/${owner}/${repo.name}/contents/${path}`, html_url: '', git_url: '', download_url: null });
        }
      }
    }
    if (entries.length > 0) {
      entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return jsonResp(200, entries);
    }
    return notFound();
  }

  if (m === 'PUT') {
    if (ctx.bodyError) return errResp(400, 'Problems parsing JSON');
    const body = isRecord(ctx.body) ? ctx.body : {};
    const message = str(body.message, 'Update file');
    const contentB64 = str(body.content);
    if (contentB64 === '' && typeof body.content !== 'string') return errResp(422, 'Validation Failed: content is required');
    const branch = str(body.branch, repo.defaultBranch);
    const sha = str(body.sha);
    const tip = repo.refs.get(`refs/heads/${branch}`);
    const files = tip ? store.flattenCommit(repo, tip) : new Map<string, { oid: string; mode: string }>();
    const existing = files.get(filePath);
    if (existing) {
      // update: sha must match current blob sha
      if (sha !== '' && sha !== existing.oid) return errResp(409, 'Conflict: sha does not match');
      if (sha === '') return errResp(422, 'Validation Failed: sha is required for updates');
      const content = b64decode(contentB64);
      const { commitSha, contentSha } = writeFileCommit(ctx, repo, branch, filePath, content, message);
      return jsonResp(200, { content: { name: filePath.split('/').pop(), path: filePath, sha: contentSha, size: Buffer.byteLength(content), encoding: 'base64', url: '', html_url: '', git_url: '', download_url: null }, commit: { sha: commitSha, message, author: { name: store.viewer(), email: `${store.viewer()}@example.invalid`, date: isoNow() }, committer: { name: store.viewer(), email: `${store.viewer()}@example.invalid`, date: isoNow() } } });
    }
    // create (also creates the branch when it does not exist yet, from the default branch)
    if (branch !== repo.defaultBranch && !repo.refs.has(`refs/heads/${branch}`)) {
      const baseTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (baseTip) repo.refs.set(`refs/heads/${branch}`, baseTip);
    }
    const content = b64decode(contentB64);
    const { commitSha, contentSha } = writeFileCommit(ctx, repo, branch, filePath, content, message);
    return jsonResp(201, { content: { name: filePath.split('/').pop(), path: filePath, sha: contentSha, size: Buffer.byteLength(content), encoding: 'base64', url: '', html_url: '', git_url: '', download_url: null }, commit: { sha: commitSha, message, author: { name: store.viewer(), email: `${store.viewer()}@example.invalid`, date: isoNow() }, committer: { name: store.viewer(), email: `${store.viewer()}@example.invalid`, date: isoNow() } } });
  }

  if (m === 'DELETE') {
    if (ctx.bodyError) return errResp(400, 'Problems parsing JSON');
    const body = isRecord(ctx.body) ? ctx.body : {};
    const message = str(body.message, 'Delete file');
    const branch = str(body.branch, repo.defaultBranch);
    const sha = str(body.sha);
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (!tip) return notFound();
    const files = store.flattenCommit(repo, tip);
    const existing = files.get(filePath);
    if (!existing) return notFound();
    if (sha !== '' && sha !== existing.oid) return errResp(409, 'Conflict: sha does not match');
    const { commitSha } = writeFileCommit(ctx, repo, branch, filePath, null, message);
    return jsonResp(200, { commit: { sha: commitSha, message, author: { name: store.viewer(), email: `${store.viewer()}@example.invalid`, date: isoNow() }, committer: { name: store.viewer(), email: `${store.viewer()}@example.invalid`, date: isoNow() } } });
  }

  return notFound();
}

// ---------------------------------------------------------------- issues

function handleIssues(ctx: ReqCtx, repo: Repo, tail: string[]): Resp {
  const store = ctx.store;
  const m = ctx.method;
  const owner = repo.owner === '' ? store.viewer() : repo.owner;

  if (tail.length === 0) {
    if (m === 'POST') {
      if (ctx.bodyError) return errResp(400, 'Problems parsing JSON');
      const body = isRecord(ctx.body) ? ctx.body : {};
      const title = str(body.title);
      if (title === '') return errResp(422, 'Validation Failed: title is required');
      const labelNames: string[] = Array.isArray(body.labels) ? body.labels.filter((x): x is string => typeof x === 'string') : [];
      const labels: Array<{ name: string; color: string }> = [];
      for (const ln of labelNames) {
        const found = repo.labels.get(ln);
        if (!found) return errResp(422, `Validation Failed: label "${ln}" does not exist`);
        labels.push(found);
      }
      const now = isoNow();
      const issue: Issue = {
        id: store.nextGlobalId++,
        number: repo.nextNumber++,
        title,
        body: str(body.body),
        state: 'open',
        labels,
        userLogin: store.viewer(),
        createdSeq: store.nextSeq(),
        createdAt: now,
        updatedAt: now,
        comments: [],
        cachedJson: '',
      };
      repo.issues.push(issue);
      cacheIssue(store, repo, issue);
      return jsonText(201, issue.cachedJson);
    }
    if (m === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      let list = repo.issues.filter((i) => (state === 'all' ? true : i.state === state));
      if (sort === 'created') {
        list = [...list].sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      }
      const { page, perPage } = pageOf(ctx.query);
      const { pageItems, link } = paginate(list, page, perPage, `${ctx.origin}/api/v3/repos/${owner}/${repo.name}/issues`);
      return jsonResp(200, pageItems.map((i) => issueJson(store, repo, i)), link ? { link } : {});
    }
    return notFound();
  }

  const number = parseInt(tail[0]!, 10);
  if (!Number.isFinite(number)) return notFound();
  const issue = repo.issues.find((i) => i.number === number);
  if (!issue) return notFound();

  if (tail.length === 1) {
    if (m === 'GET') return jsonText(200, issue.cachedJson === '' ? JSON.stringify(issueJson(store, repo, issue)) : issue.cachedJson);
    if (m === 'PATCH') {
      if (ctx.bodyError) return errResp(400, 'Problems parsing JSON');
      const body = isRecord(ctx.body) ? ctx.body : {};
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (Array.isArray(body.labels)) {
        const labels: Array<{ name: string; color: string }> = [];
        for (const ln of body.labels) {
          if (typeof ln !== 'string') continue;
          const found = repo.labels.get(ln);
          if (!found) return errResp(422, `Validation Failed: label "${ln}" does not exist`);
          labels.push(found);
        }
        issue.labels = labels;
      }
      issue.updatedAt = isoNow();
      cacheIssue(store, repo, issue);
      return jsonText(200, issue.cachedJson);
    }
    return notFound();
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    if (m === 'GET') {
      return jsonResp(200, issue.comments.map((c) => ({ id: c.id, node_id: store.globalId('IssueComment', `${owner}/${repo.name}#${issue.number}:${c.id}`), body: c.body, user: userJson(store, c.userLogin), created_at: c.createdAt, updated_at: c.createdAt, html_url: '', url: '' })));
    }
    if (m === 'POST') {
      if (ctx.bodyError) return errResp(400, 'Problems parsing JSON');
      const body = isRecord(ctx.body) ? ctx.body : {};
      const cbody = str(body.body);
      if (cbody === '') return errResp(422, 'Validation Failed: body is required');
      const comment = { id: repo.nextCommentId++, body: cbody, userLogin: store.viewer(), createdAt: isoNow() };
      issue.comments.push(comment);
      issue.updatedAt = isoNow();
      cacheIssue(store, repo, issue);
      return jsonResp(201, { id: comment.id, node_id: store.globalId('IssueComment', `${owner}/${repo.name}#${issue.number}:${comment.id}`), body: comment.body, user: userJson(store, comment.userLogin), created_at: comment.createdAt, updated_at: comment.createdAt, html_url: '', url: '' });
    }
    return notFound();
  }

  return notFound();
}

// ---------------------------------------------------------------- pulls

function handlePulls(ctx: ReqCtx, repo: Repo, tail: string[]): Resp {
  const store = ctx.store;
  const m = ctx.method;
  const owner = repo.owner === '' ? store.viewer() : repo.owner;

  if (tail.length === 0) {
    if (m === 'POST') {
      if (ctx.bodyError) return errResp(400, 'Problems parsing JSON');
      const body = isRecord(ctx.body) ? ctx.body : {};
      const head = str(body.head);
      const base = str(body.base, repo.defaultBranch);
      const title = str(body.title);
      if (head === '' || title === '') return errResp(422, 'Validation Failed');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return errResp(422, 'Validation Failed: head or base branch does not exist');
      const existing = repo.pulls.find((p) => p.headRef === head && p.baseRef === base && p.state === 'open');
      if (existing) return errResp(422, 'Validation Failed: A pull request already exists');
      const headFiles = store.flattenCommit(repo, headSha);
      const baseFiles = store.flattenCommit(repo, baseSha);
      const files = store.diffFiles(repo, baseFiles, headFiles);
      const mergeable = !store.hasConflict(repo, base, head);
      const now = isoNow();
      const pull: Pull = {
        id: store.nextGlobalId++,
        number: repo.nextNumber++,
        title,
        body: str(body.body),
        state: 'open',
        draft: bool(body.draft, false),
        headRef: head,
        headSha,
        baseRef: base,
        baseSha,
        merged: false,
        mergeable,
        mergeCommitSha: null,
        mergedAt: null,
        userLogin: store.viewer(),
        createdSeq: store.nextSeq(),
        createdAt: now,
        updatedAt: now,
        files,
      };
      repo.pulls.push(pull);
      return jsonResp(201, pullJson(store, repo, pull));
    }
    if (m === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const list = repo.pulls.filter((p) => (state === 'all' ? true : p.state === state));
      const { page, perPage } = pageOf(ctx.query);
      const { pageItems, link } = paginate(list, page, perPage, `${ctx.origin}/api/v3/repos/${owner}/${repo.name}/pulls`);
      return jsonResp(200, pageItems.map((p) => pullJson(store, repo, p)), link ? { link } : {});
    }
    return notFound();
  }

  const number = parseInt(tail[0]!, 10);
  if (!Number.isFinite(number)) return notFound();
  const pull = repo.pulls.find((p) => p.number === number);
  if (!pull) return notFound();

  if (tail.length === 1) {
    if (m === 'GET') return jsonResp(200, pullJson(store, repo, pull));
    return notFound();
  }

  if (tail.length === 2 && tail[1] === 'files' && m === 'GET') {
    return jsonResp(200, pull.files.map((f) => ({ sha: '', filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes, blob_url: '', raw_url: '', contents_url: '' })));
  }

  if (tail.length === 2 && tail[1] === 'merge' && m === 'PUT') {
    if (ctx.bodyError) return errResp(400, 'Problems parsing JSON');
    const body = isRecord(ctx.body) ? ctx.body : {};
    const method = str(body.merge_method, 'merge').toLowerCase();
    if (pull.merged || pull.state === 'closed') return errResp(405, 'Pull request is already merged or closed');
    // Recompute conflict against the CURRENT base tip.
    const currentBaseSha = repo.refs.get(`refs/heads/${pull.baseRef}`);
    const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    if (!currentBaseSha) return notFound();
    const conflict = store.hasConflict(repo, pull.baseRef, pull.headRef);
    if (conflict) return errResp(405, 'Merge conflict');
    const now = new Date();
    let mergeSha: string;
    if (method === 'squash') {
      const headFiles = store.flattenCommit(repo, headSha);
      const tree = store.buildTreeFromFiles(repo, headFiles);
      const author = ident(store.viewer(), now);
      const msg = `${pull.title} (#${pull.number})\n`;
      const data = buildCommit({ tree, parents: [currentBaseSha], author, committer: author, message: msg });
      mergeSha = store.putObject(repo, 'commit', data);
      repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    } else if (method === 'rebase') {
      if (isAncestor(currentBaseSha, headSha, (oid: string) => repo.objects.get(oid))) {
        mergeSha = headSha;
        repo.refs.set(`refs/heads/${pull.baseRef}`, headSha);
      } else {
        const headFiles = store.flattenCommit(repo, headSha);
        const tree = store.buildTreeFromFiles(repo, headFiles);
        const author = ident(store.viewer(), now);
        const data = buildCommit({ tree, parents: [currentBaseSha], author, committer: author, message: `${pull.title} (#${pull.number})\n` });
        mergeSha = store.putObject(repo, 'commit', data);
        repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
      }
    } else {
      // merge commit
      const headFiles = store.flattenCommit(repo, headSha);
      const tree = store.buildTreeFromFiles(repo, headFiles);
      const author = ident(store.viewer(), now);
      const data = buildCommit({ tree, parents: [currentBaseSha, headSha], author, committer: author, message: `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n` });
      mergeSha = store.putObject(repo, 'commit', data);
      repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    }
    pull.merged = true;
    pull.state = 'closed';
    pull.mergeCommitSha = mergeSha;
    pull.mergedAt = now.toISOString();
    pull.updatedAt = now.toISOString();
    repo.version += 1;
    repo.advCache.clear();
    repo.packCache.clear();
    return jsonResp(200, { sha: mergeSha, merged: true, message: 'Pull request successfully merged' });
  }

  return notFound();
}
