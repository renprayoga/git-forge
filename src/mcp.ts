// MCP over Streamable HTTP at POST /mcp — JSON-RPC 2.0.
// Supports the modern 2026-07-28 revision (server/discover) and the legacy
// initialize handshake (2025-11-25 and earlier). Written from scratch.

import { isoNow, isRecord, jsonResp, str, type ReqCtx, type Resp } from './http.ts';
import { buildCommit, ident, type Issue, type Pull, type Repo, type Store } from './store.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'Repository name' },
      description: { type: 'string', description: 'Repository description' },
      private: { type: 'boolean', description: 'Whether the repository is private' },
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      title: { type: 'string', description: 'Issue title' },
      body: { type: 'string', description: 'Issue body' },
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      state: { type: 'string', description: 'Issue state filter: open, closed, or all' },
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      title: { type: 'string', description: 'Pull request title' },
      body: { type: 'string', description: 'Pull request body' },
      head: { type: 'string', description: 'Head branch name' },
      base: { type: 'string', description: 'Base branch name' },
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      pull_number: { type: 'number', description: 'Pull request number' },
    },
  },
  {
    name: 'get_issue',
    description: 'Get a single issue by number.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      issue_number: { type: 'number', description: 'Issue number' },
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    properties: {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      state: { type: 'string', description: 'Pull request state filter: open, closed, or all' },
    },
  },
];

function toolsList(): unknown {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: { type: 'object', properties: t.properties, required: [] },
  }));
}

function rpcResult(id: unknown, result: unknown): Resp {
  return jsonResp(200, { jsonrpc: '2.0', id, result });
}

function rpcError(id: unknown, code: number, message: string): Resp {
  return jsonResp(200, { jsonrpc: '2.0', id, error: { code, message } });
}

function toolTextResult(payload: unknown): Record<string, unknown> {
  const text = JSON.stringify(payload);
  return { content: [{ type: 'text', text }], structuredContent: payload, isError: false };
}

function toolErrorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function resolveRepo(store: Store, owner: string, repoName: string): Repo | null {
  if (owner === '') return null;
  if (store.viewerLogin === null) store.bindViewer(owner);
  if (owner !== store.viewerLogin) return null;
  return store.getRepo(owner, repoName) ?? null;
}

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const owner = repo.owner === '' ? store.viewer() : repo.owner;
  return {
    id: repo.id,
    node_id: store.globalId('Repository', `${owner}/${repo.name}`),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://example.invalid/${owner}/${repo.name}`,
  };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  const owner = repo.owner === '' ? store.viewer() : repo.owner;
  return {
    id: issue.id,
    node_id: store.globalId('Issue', `${owner}/${repo.name}#${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: issue.userLogin, id: 1000, type: 'User' },
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://example.invalid/${owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const owner = repo.owner === '' ? store.viewer() : repo.owner;
  return {
    id: pull.id,
    node_id: store.globalId('PullRequest', `${owner}/${repo.name}#${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: pull.mergeable,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://example.invalid/${owner}/${repo.name}/pull/${pull.number}`,
  };
}

function callTool(ctx: ReqCtx, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const store = ctx.store;
  const owner = str(args.owner);
  const repoName = str(args.repo);

  switch (name) {
    case 'create_repo': {
      const rname = str(args.name).trim();
      if (rname === '') return toolErrorResult('name is required');
      const ownerLogin = store.viewer();
      const existing = store.getRepo(ownerLogin, rname) ?? (store.viewerLogin === null ? store.getRepo('', rname) : undefined);
      if (existing) return toolErrorResult('Repository already exists');
      const repo = store.createRepo(store.viewerLogin ?? '', rname, str(args.description), args.private === true);
      return toolTextResult(repoJson(store, repo));
    }
    case 'get_repo': {
      const repo = resolveRepo(store, owner, repoName);
      if (!repo) return toolErrorResult('Repository not found');
      return toolTextResult(repoJson(store, repo));
    }
    case 'create_issue': {
      const repo = resolveRepo(store, owner, repoName);
      if (!repo) return toolErrorResult('Repository not found');
      const title = str(args.title);
      if (title === '') return toolErrorResult('title is required');
      const now = isoNow();
      const issue: Issue = {
        id: store.nextGlobalId++,
        number: repo.nextNumber++,
        title,
        body: str(args.body),
        state: 'open',
        labels: [],
        userLogin: store.viewer(),
        createdSeq: store.nextSeq(),
        createdAt: now,
        updatedAt: now,
        comments: [],
        cachedJson: '',
      };
      repo.issues.push(issue);
      return toolTextResult(issueJson(store, repo, issue));
    }
    case 'list_issues': {
      const repo = resolveRepo(store, owner, repoName);
      if (!repo) return toolErrorResult('Repository not found');
      const state = str(args.state, 'open');
      const list = repo.issues.filter((i) => (state === 'all' ? true : i.state === state));
      return toolTextResult({ issues: list.map((i) => issueJson(store, repo, i)) });
    }
    case 'create_pull_request': {
      const repo = resolveRepo(store, owner, repoName);
      if (!repo) return toolErrorResult('Repository not found');
      const head = str(args.head);
      const base = str(args.base, repo.defaultBranch);
      const title = str(args.title);
      if (head === '' || title === '') return toolErrorResult('head and title are required');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return toolErrorResult('head or base branch does not exist');
      const now = isoNow();
      const headFiles = store.flattenCommit(repo, headSha);
      const baseFiles = store.flattenCommit(repo, baseSha);
      const pull: Pull = {
        id: store.nextGlobalId++,
        number: repo.nextNumber++,
        title,
        body: str(args.body),
        state: 'open',
        draft: false,
        headRef: head,
        headSha,
        baseRef: base,
        baseSha,
        merged: false,
        mergeable: !store.hasConflict(repo, base, head),
        mergeCommitSha: null,
        mergedAt: null,
        userLogin: store.viewer(),
        createdSeq: store.nextSeq(),
        createdAt: now,
        updatedAt: now,
        files: store.diffFiles(repo, baseFiles, headFiles),
      };
      repo.pulls.push(pull);
      return toolTextResult(pullJson(store, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = resolveRepo(store, owner, repoName);
      if (!repo) return toolErrorResult('Repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : parseInt(str(args.pull_number), 10);
      if (!Number.isFinite(number)) return toolErrorResult('pull_number is required');
      const pull = repo.pulls.find((p) => p.number === number);
      if (!pull) return toolErrorResult('Pull request not found');
      if (pull.merged || pull.state === 'closed') return toolErrorResult('Pull request is already merged or closed');
      if (store.hasConflict(repo, pull.baseRef, pull.headRef)) return toolErrorResult('Merge conflict');
      const currentBaseSha = repo.refs.get(`refs/heads/${pull.baseRef}`);
      const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
      if (!currentBaseSha) return toolErrorResult('Base branch not found');
      // Squash merge: one commit on the base with the head's tree.
      const headFiles = store.flattenCommit(repo, headSha);
      const tree = store.buildTreeFromFiles(repo, headFiles);
      const now = new Date();
      const author = ident(store.viewer(), now);
      const data = buildCommit({ tree, parents: [currentBaseSha], author, committer: author, message: `${pull.title} (#${pull.number})\n` });
      const mergeSha = store.putObject(repo, 'commit', data);
      repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
      pull.merged = true;
      pull.state = 'closed';
      pull.mergeCommitSha = mergeSha;
      pull.mergedAt = now.toISOString();
      pull.updatedAt = now.toISOString();
      repo.version += 1;
      repo.advCache.clear();
      repo.packCache.clear();
      return toolTextResult({ merged: true, number: pull.number, state: pull.state, sha: mergeSha });
    }
    case 'get_issue': {
      const repo = resolveRepo(store, owner, repoName);
      if (!repo) return toolErrorResult('Repository not found');
      const number = typeof args.issue_number === 'number' ? args.issue_number : parseInt(str(args.issue_number), 10);
      const issue = repo.issues.find((i) => i.number === number);
      if (!issue) return toolErrorResult('Issue not found');
      return toolTextResult(issueJson(store, repo, issue));
    }
    case 'list_pull_requests': {
      const repo = resolveRepo(store, owner, repoName);
      if (!repo) return toolErrorResult('Repository not found');
      const state = str(args.state, 'open');
      const list = repo.pulls.filter((p) => (state === 'all' ? true : p.state === state));
      return toolTextResult({ pull_requests: list.map((p) => pullJson(store, repo, p)) });
    }
    default:
      return toolErrorResult(`Unknown tool: ${name}`);
  }
}

export function handleMcp(ctx: ReqCtx): Resp {
  if (ctx.bodyError) {
    return jsonResp(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const body = ctx.body;
  if (!isRecord(body) || typeof body.method !== 'string') {
    return jsonResp(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
  }
  const id = body.id ?? null;
  const isNotification = body.id === undefined;
  const method = body.method;
  const params = isRecord(body.params) ? body.params : {};

  // Notifications get no response body (202).
  if (isNotification) {
    return { status: 202, body: '', contentType: 'application/json' };
  }

  if (method === 'server/discover') {
    return rpcResult(id, {
      protocolVersion: '2026-07-28',
      supportedVersions: REVISIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }

  if (method === 'initialize') {
    const requested = str(params.protocolVersion, '2025-11-25');
    const negotiated = REVISIONS.includes(requested) ? requested : '2025-11-25';
    return rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: toolsList() });
  }

  if (method === 'tools/call') {
    const name = str(params.name);
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
    const result = callTool(ctx, name, args);
    return rpcResult(id, result);
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}
