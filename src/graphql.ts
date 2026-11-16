// GraphQL over POST /api/graphql — a small executor for the fixed documents
// gh and github-mcp-server send (see the kit's checks-graphql.ts).
// Written from scratch for this entry.

import {
  buildCommit,
  ident,
  isAncestor,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { b64decode, b64encode, errResp, isRecord, isoNow, jsonResp, str, type ReqCtx, type Resp } from './http.ts';

// ---------------------------------------------------------------- lexer

type Tok =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '.' && src.slice(i, i + 3) === '...') {
      toks.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      toks.push({ kind: 'punct', value: ch });
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      toks.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      toks.push({ kind: 'int', value: parseInt(src.slice(i, j), 10) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      toks.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`graphql: unexpected character ${JSON.stringify(ch)}`);
  }
  return toks;
}

// ---------------------------------------------------------------- parser

export interface GqlValue {
  kind: 'var' | 'string' | 'int' | 'bool' | 'null' | 'enum' | 'list' | 'object';
  name?: string;
  value?: string | number | boolean;
  items?: GqlValue[];
  fields?: Array<{ name: string; value: GqlValue }>;
}

export interface GqlField {
  alias: string;
  name: string;
  args: Array<{ name: string; value: GqlValue }>;
  selection: GqlField[];
  typeCondition: string | null; // for inline fragments
  fragment: boolean;
}

export interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; type: string; required: boolean }>;
  selection: GqlField[];
}

class Parser {
  private pos = 0;
  private readonly toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  peek(): Tok | undefined {
    return this.toks[this.pos];
  }

  next(): Tok {
    const t = this.toks[this.pos];
    if (!t) throw new Error('graphql: unexpected end of document');
    this.pos++;
    return t;
  }

  expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`graphql: expected ${v}`);
  }

  maybePunct(v: string): boolean {
    const t = this.peek();
    if (t && t.kind === 'punct' && t.value === v) {
      this.pos++;
      return true;
    }
    return false;
  }

  expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error('graphql: expected name');
    return t.value;
  }

  parseDocument(): GqlOperation[] {
    const ops: GqlOperation[] = [];
    while (this.pos < this.toks.length) {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  parseOperation(): GqlOperation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const t = this.peek();
    if (t?.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      const kw = this.next();
      kind = kw.kind === 'name' ? (kw.value as 'query' | 'mutation') : 'query';
      const n = this.peek();
      if (n?.kind === 'name') name = n.value;
      if (name !== null) this.next();
    }
    const variables: GqlOperation['variables'] = [];
    if (this.maybePunct('(')) {
      while (!this.maybePunct(')')) {
        this.expectPunct('$');
        const vname = this.expectName();
        this.expectPunct(':');
        // type: Name, [Name], Name!, [Name!]!
        let type = '';
        if (this.maybePunct('[')) {
          type = '[' + this.expectName();
          if (this.maybePunct('!')) type += '!';
          this.expectPunct(']');
          type += ']';
        } else {
          type = this.expectName();
        }
        let required = false;
        if (this.maybePunct('!')) required = true;
        variables.push({ name: vname, type, required });
      }
    }
    const selection = this.parseSelectionSet();
    return { kind, name, variables, selection };
  }

  parseSelectionSet(): GqlField[] {
    this.expectPunct('{');
    const fields: GqlField[] = [];
    while (!this.maybePunct('}')) {
      fields.push(this.parseField());
    }
    return fields;
  }

  parseField(): GqlField {
    const t = this.peek();
    if (t?.kind === 'spread') {
      this.next();
      let typeCondition: string | null = null;
      const on = this.peek();
      if (on?.kind === 'name' && on.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      const selection = this.parseSelectionSet();
      return { alias: '', name: '', args: [], selection, typeCondition, fragment: true };
    }
    const first = this.expectName();
    let alias = first;
    let name = first;
    const colon = this.peek();
    if (colon?.kind === 'punct' && colon.value === ':') {
      this.next();
      name = this.expectName();
    }
    const args: Array<{ name: string; value: GqlValue }> = [];
    if (this.maybePunct('(')) {
      while (!this.maybePunct(')')) {
        const aname = this.expectName();
        this.expectPunct(':');
        args.push({ name: aname, value: this.parseValue() });
      }
    }
    let selection: GqlField[] = [];
    const brace = this.peek();
    if (brace?.kind === 'punct' && brace.value === '{') selection = this.parseSelectionSet();
    return { alias, name, args, selection, typeCondition: null, fragment: false };
  }

  parseValue(): GqlValue {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'var', name: this.expectName() };
    if (t.kind === 'punct' && t.value === '[') {
      const items: GqlValue[] = [];
      while (!this.maybePunct(']')) items.push(this.parseValue());
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (!this.maybePunct('}')) {
        const fname = this.expectName();
        this.expectPunct(':');
        fields.push({ name: fname, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'bool', value: true };
      if (t.value === 'false') return { kind: 'bool', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error('graphql: bad value');
  }
}

// ---------------------------------------------------------------- schema knowledge

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'url', 'comments', 'labels', 'closedAt'];
const PULL_REQUEST_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'mergeCommit', 'files', 'createdAt', 'updatedAt', 'author', 'url'];
const REPOSITORY_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt', 'description', 'isPrivate', 'url'];
const USER_FIELDS = ['id', 'login', 'name', 'avatarUrl', 'url'];
const QUERY_FIELDS = ['viewer', 'repository', 'node', '__type', '__schema'];
const MUTATION_FIELDS = ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'];

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ISSUE_FIELDS,
  PullRequest: PULL_REQUEST_FIELDS,
  Repository: REPOSITORY_FIELDS,
  User: USER_FIELDS,
  Query: QUERY_FIELDS,
  Mutation: MUTATION_FIELDS,
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
  Ref: ['name'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  IssueCommentEdge: ['node'],
  IssueComment: ['id', 'body'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------- executor

interface ExecCtx {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function resolveValue(v: GqlValue, variables: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'var':
      return variables[v.name ?? ''];
    case 'string':
    case 'int':
    case 'bool':
    case 'enum':
      return v.value;
    case 'null':
      return null;
    case 'list':
      return (v.items ?? []).map((x) => resolveValue(x, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of v.fields ?? []) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

function argMap(field: GqlField, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = resolveValue(a.value, ctx.variables);
  return out;
}

function fieldError(ctx: ExecCtx, typeName: string, field: string): void {
  ctx.errors.push({ message: `Cannot query field "${field}" on type "${typeName}".` });
}

function selectFields(
  ctx: ExecCtx,
  typeName: string,
  fields: GqlField[],
  resolve: (field: GqlField) => unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const known = TYPE_FIELDS[typeName] ?? [];
  for (const f of fields) {
    if (f.fragment) {
      if (f.typeCondition === null || f.typeCondition === typeName) {
        Object.assign(out, selectFields(ctx, typeName, f.selection, resolve));
      }
      continue;
    }
    if (!known.includes(f.name)) {
      fieldError(ctx, typeName, f.name);
      continue;
    }
    out[f.alias] = resolve(f);
  }
  return out;
}

function userNode(ctx: ExecCtx, login: string, fields: GqlField[]): Record<string, unknown> {
  return selectFields(ctx, 'User', fields, (f) => {
    if (f.name === 'login') return login;
    if (f.name === 'id') return ctx.store.globalId('User', login);
    if (f.name === 'name') return login;
    if (f.name === 'avatarUrl') return '';
    if (f.name === 'url') return '';
    return null;
  });
}

function issueNode(ctx: ExecCtx, repo: Repo, issue: Issue, fields: GqlField[]): Record<string, unknown> {
  const owner = repo.owner === '' ? ctx.store.viewer() : repo.owner;
  return selectFields(ctx, 'Issue', fields, (f) => {
    switch (f.name) {
      case 'id':
        return ctx.store.globalId('Issue', `${owner}/${repo.name}#${issue.number}`);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'body':
        return issue.body;
      case 'createdAt':
        return issue.createdAt;
      case 'updatedAt':
        return issue.updatedAt;
      case 'author':
        return f.selection.length > 0 ? userNode(ctx, issue.userLogin, f.selection) : { login: issue.userLogin };
      case 'url':
        return '';
      case 'comments':
        return { totalCount: issue.comments.length };
      case 'labels':
        return { nodes: issue.labels.map((l) => ({ name: l.name, color: l.color })) };
      case 'closedAt':
        return issue.state === 'closed' ? issue.updatedAt : null;
      default:
        return null;
    }
  });
}

function pullNode(ctx: ExecCtx, repo: Repo, pull: Pull, fields: GqlField[]): Record<string, unknown> {
  const owner = repo.owner === '' ? ctx.store.viewer() : repo.owner;
  return selectFields(ctx, 'PullRequest', fields, (f) => {
    switch (f.name) {
      case 'id':
        return ctx.store.globalId('PullRequest', `${owner}/${repo.name}#${pull.number}`);
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'merged':
        return pull.merged;
      case 'mergeable':
        return pull.mergeable ? 'MERGEABLE' : 'CONFLICTING';
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'headRef':
        return f.selection.length > 0 ? selectFields(ctx, 'Ref', f.selection, (g) => (g.name === 'name' ? pull.headRef : null)) : { name: pull.headRef };
      case 'baseRef':
        return f.selection.length > 0 ? selectFields(ctx, 'Ref', f.selection, (g) => (g.name === 'name' ? pull.baseRef : null)) : { name: pull.baseRef };
      case 'mergeCommit':
        return pull.mergeCommitSha ? { oid: pull.mergeCommitSha } : null;
      case 'files': {
        const args = argMap(f, ctx);
        const first = typeof args.first === 'number' ? args.first : 100;
        const nodes = pull.files.slice(0, first).map((x) => ({ path: x.filename, additions: x.additions, deletions: x.deletions, changeType: x.status === 'added' ? 'ADDED' : x.status === 'removed' ? 'REMOVED' : 'MODIFIED' }));
        return connection(nodes, f.selection, ctx, 'PullRequestChangedFileConnection', (node, sel) =>
          selectFields(ctx, 'PullRequestChangedFile', sel, (g) => {
            const n = node as { path: string; additions: number; deletions: number; changeType: string };
            if (g.name === 'path') return n.path;
            if (g.name === 'additions') return n.additions;
            if (g.name === 'deletions') return n.deletions;
            if (g.name === 'changeType') return n.changeType;
            return null;
          }),
        );
      }
      case 'createdAt':
        return pull.createdAt;
      case 'updatedAt':
        return pull.updatedAt;
      case 'author':
        return f.selection.length > 0 ? userNode(ctx, pull.userLogin, f.selection) : { login: pull.userLogin };
      case 'url':
        return '';
      default:
        return null;
    }
  });
}

function cursorFor(n: number): string {
  return b64encode(`cursor:${n}`);
}

function cursorToNumber(cursor: string | null | undefined): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = b64decode(cursor);
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? parseInt(m[1]!, 10) : null;
  } catch {
    return null;
  }
}

function connection<T>(
  nodes: T[],
  selection: GqlField[],
  ctx: ExecCtx,
  typeName: string,
  renderNode: (node: T, sel: GqlField[]) => Record<string, unknown>,
): Record<string, unknown> {
  return selectFields(ctx, typeName, selection, (f) => {
    if (f.name === 'nodes') return nodes.map((n) => renderNode(n, f.selection));
    if (f.name === 'edges') return nodes.map((n, i) => ({ node: renderNode(n, f.selection.length > 0 ? f.selection : []), cursor: cursorFor(i + 1) }));
    if (f.name === 'pageInfo') {
      return selectFields(ctx, 'PageInfo', f.selection, (g) => {
        if (g.name === 'hasNextPage') return false;
        if (g.name === 'hasPreviousPage') return false;
        if (g.name === 'endCursor') return nodes.length > 0 ? cursorFor(nodes.length) : null;
        if (g.name === 'startCursor') return nodes.length > 0 ? cursorFor(1) : null;
        return null;
      });
    }
    if (f.name === 'totalCount') return nodes.length;
    return null;
  });
}

function repositoryNode(ctx: ExecCtx, repo: Repo, fields: GqlField[]): Record<string, unknown> {
  const store = ctx.store;
  const owner = repo.owner === '' ? store.viewer() : repo.owner;
  return selectFields(ctx, 'Repository', fields, (f) => {
    switch (f.name) {
      case 'id':
        return store.globalId('Repository', `${owner}/${repo.name}`);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${owner}/${repo.name}`;
      case 'owner':
        return f.selection.length > 0 ? userNode(ctx, owner, f.selection) : { login: owner };
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (!tip) return null;
        return selectFields(ctx, 'Ref', f.selection, (g) => (g.name === 'name' ? repo.defaultBranch : null));
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'issue': {
        const args = argMap(f, ctx);
        const issue = repo.issues.find((i) => i.number === args.number);
        return issue ? issueNode(ctx, repo, issue, f.selection) : null;
      }
      case 'issues': {
        const args = argMap(f, ctx);
        const first = typeof args.first === 'number' ? args.first : 100;
        const afterNum = cursorToNumber(typeof args.after === 'string' ? args.after : null);
        let list = [...repo.issues];
        if (Array.isArray(args.states)) {
          const wanted = new Set((args.states as unknown[]).map((s) => String(s).toLowerCase()));
          list = list.filter((i) => wanted.has(i.state));
        }
        if (isRecord(args.orderBy)) {
          const field = String(args.orderBy.field ?? 'CREATED_AT');
          const dir = String(args.orderBy.direction ?? 'DESC');
          list.sort((a, b) => {
            const av = field === 'UPDATED_AT' ? a.updatedAt : a.createdSeq;
            const bv = field === 'UPDATED_AT' ? b.updatedAt : b.createdSeq;
            if (av !== bv) return dir === 'ASC' ? (av < bv ? -1 : 1) : av > bv ? -1 : 1;
            return dir === 'ASC' ? a.number - b.number : b.number - a.number;
          });
        } else {
          list.sort((a, b) => a.number - b.number);
        }
        if (afterNum !== null) list = list.filter((i) => i.number > afterNum);
        const page = list.slice(0, first);
        const hasNext = list.length > first;
        const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null;
        return selectFields(ctx, 'IssueConnection', f.selection, (g) => {
          if (g.name === 'nodes') return page.map((i) => issueNode(ctx, repo, i, g.selection));
          if (g.name === 'edges') return page.map((i) => ({ node: issueNode(ctx, repo, i, g.selection.length > 0 ? g.selection : []), cursor: cursorFor(i.number) }));
          if (g.name === 'pageInfo') {
            return selectFields(ctx, 'PageInfo', g.selection, (h) => {
              if (h.name === 'hasNextPage') return hasNext;
              if (h.name === 'hasPreviousPage') return false;
              if (h.name === 'endCursor') return endCursor;
              if (h.name === 'startCursor') return page.length > 0 ? cursorFor(page[0]!.number) : null;
              return null;
            });
          }
          if (g.name === 'totalCount') return list.length;
          return null;
        });
      }
      case 'pullRequests': {
        const args = argMap(f, ctx);
        const first = typeof args.first === 'number' ? args.first : 100;
        const page = repo.pulls.slice(0, first);
        return connection(page, f.selection, ctx, 'PullRequestConnection', (p, sel) => pullNode(ctx, repo, p, sel));
      }
      case 'pullRequest': {
        const args = argMap(f, ctx);
        const pull = repo.pulls.find((p) => p.number === args.number);
        return pull ? pullNode(ctx, repo, pull, f.selection) : null;
      }
      case 'createdAt':
        return repo.createdAt;
      case 'updatedAt':
        return repo.updatedAt;
      case 'description':
        return repo.description;
      case 'isPrivate':
        return repo.private;
      case 'url':
        return '';
      default:
        return null;
    }
  });
}

function typeNode(ctx: ExecCtx, name: string, fields: GqlField[]): Record<string, unknown> | null {
  const known = TYPE_FIELDS[name] ?? ENUM_VALUES[name] ? name : null;
  if (known === null && !ENUM_VALUES[name]) return null;
  return selectFields(ctx, '__Type', fields, (f) => {
    if (f.name === 'name') return name;
    if (f.name === 'kind') return ENUM_VALUES[name] ? 'ENUM' : 'OBJECT';
    if (f.name === 'fields') {
      const list = TYPE_FIELDS[name] ?? [];
      return list.map((fn) => ({ name: fn, description: null }));
    }
    if (f.name === 'enumValues') {
      const list = ENUM_VALUES[name] ?? [];
      return list.map((en) => ({ name: en, description: null }));
    }
    if (f.name === 'description') return null;
    return null;
  });
}

function mergePull(store: Store, repo: Repo, pull: Pull, method: string): { ok: boolean; reason?: string } {
  const currentBaseSha = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  if (!currentBaseSha) return { ok: false, reason: 'base branch not found' };
  if (pull.merged || pull.state === 'closed') return { ok: false, reason: 'already merged or closed' };
  if (store.hasConflict(repo, pull.baseRef, pull.headRef)) return { ok: false, reason: 'merge conflict' };
  const now = new Date();
  let mergeSha: string;
  if (method === 'REBASE' && isAncestor(currentBaseSha, headSha, (oid) => repo.objects.get(oid))) {
    mergeSha = headSha;
    repo.refs.set(`refs/heads/${pull.baseRef}`, headSha);
  } else {
    const headFiles = store.flattenCommit(repo, headSha);
    const tree = store.buildTreeFromFiles(repo, headFiles);
    const author = ident(store.viewer(), now);
    const parents = method === 'SQUASH' || method === 'REBASE' ? [currentBaseSha] : [currentBaseSha, headSha];
    const message = method === 'SQUASH' ? `${pull.title} (#${pull.number})\n` : `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
    const data = buildCommit({ tree, parents, author, committer: author, message });
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
  return { ok: true };
}

function executeOperation(ctx: ExecCtx, op: GqlOperation): Record<string, unknown> {
  const store = ctx.store;
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  return selectFields(ctx, rootType, op.selection, (f) => {
    if (op.kind === 'query') {
      switch (f.name) {
        case 'viewer':
          return f.selection.length > 0 ? userNode(ctx, store.viewer(), f.selection) : { login: store.viewer() };
        case 'repository': {
          const args = argMap(f, ctx);
          const owner = str(args.owner);
          const name = str(args.name);
          if (store.viewerLogin === null && owner !== '') store.bindViewer(owner);
          if (owner !== store.viewerLogin) return null;
          const repo = store.getRepo(owner, name);
          return repo ? repositoryNode(ctx, repo, f.selection) : null;
        }
        case 'node': {
          const args = argMap(f, ctx);
          const decoded = store.decodeGlobalId(str(args.id));
          if (!decoded) return null;
          if (decoded.kind === 'Repository') {
            const [owner, name] = decoded.ref.split('/');
            if (!owner || !name) return null;
            if (store.viewerLogin === null) store.bindViewer(owner);
            if (owner !== store.viewerLogin) return null;
            const repo = store.getRepo(owner, name);
            return repo ? repositoryNode(ctx, repo, f.selection) : null;
          }
          if (decoded.kind === 'Issue') {
            const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(decoded.ref);
            if (!m) return null;
            const repo = store.getRepo(m[1]!, m[2]!);
            const issue = repo?.issues.find((i) => i.number === parseInt(m[3]!, 10));
            return repo && issue ? issueNode(ctx, repo, issue, f.selection) : null;
          }
          if (decoded.kind === 'PullRequest') {
            const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(decoded.ref);
            if (!m) return null;
            const repo = store.getRepo(m[1]!, m[2]!);
            const pull = repo?.pulls.find((p) => p.number === parseInt(m[3]!, 10));
            return repo && pull ? pullNode(ctx, repo, pull, f.selection) : null;
          }
          return null;
        }
        case '__type': {
          const args = argMap(f, ctx);
          return typeNode(ctx, str(args.name), f.selection);
        }
        case '__schema':
          return { queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } };
        default:
          return null;
      }
    }
    // mutations
    const args = argMap(f, ctx);
    const input = isRecord(args.input) ? args.input : {};
    switch (f.name) {
      case 'createIssue': {
        const decoded = store.decodeGlobalId(str(input.repositoryId));
        if (!decoded || decoded.kind !== 'Repository') return null;
        const [owner, name] = decoded.ref.split('/');
        const repo = owner && name ? store.getRepo(owner, name) : undefined;
        if (!repo) return null;
        const now = isoNow();
        const issue: Issue = {
          id: store.nextGlobalId++,
          number: repo.nextNumber++,
          title: str(input.title),
          body: str(input.body),
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
        return selectFields(ctx, 'CreateIssuePayload', f.selection, (g) => {
          if (g.name === 'issue') return issueNode(ctx, repo, issue, g.selection);
          return null;
        });
      }
      case 'closeIssue': {
        const decoded = store.decodeGlobalId(str(input.issueId));
        if (!decoded || decoded.kind !== 'Issue') return null;
        const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(decoded.ref);
        if (!m) return null;
        const repo = store.getRepo(m[1]!, m[2]!);
        const issue = repo?.issues.find((i) => i.number === parseInt(m[3]!, 10));
        if (!repo || !issue) return null;
        issue.state = 'closed';
        issue.updatedAt = isoNow();
        issue.cachedJson = '';
        return selectFields(ctx, 'CloseIssuePayload', f.selection, (g) => {
          if (g.name === 'issue') return issueNode(ctx, repo, issue, g.selection);
          return null;
        });
      }
      case 'createPullRequest': {
        const decoded = store.decodeGlobalId(str(input.repositoryId));
        if (!decoded || decoded.kind !== 'Repository') return null;
        const [owner, name] = decoded.ref.split('/');
        const repo = owner && name ? store.getRepo(owner, name) : undefined;
        if (!repo) return null;
        const head = str(input.headRefName);
        const base = str(input.baseRefName, repo.defaultBranch);
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (!headSha || !baseSha) {
          ctx.errors.push({ message: `Validation Failed: head or base branch does not exist` });
          return null;
        }
        const now = isoNow();
        const headFiles = store.flattenCommit(repo, headSha);
        const baseFiles = store.flattenCommit(repo, baseSha);
        const files = store.diffFiles(repo, baseFiles, headFiles);
        const pull: Pull = {
          id: store.nextGlobalId++,
          number: repo.nextNumber++,
          title: str(input.title),
          body: str(input.body),
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
          files,
        };
        repo.pulls.push(pull);
        return selectFields(ctx, 'CreatePullRequestPayload', f.selection, (g) => {
          if (g.name === 'pullRequest') return pullNode(ctx, repo, pull, g.selection);
          return null;
        });
      }
      case 'mergePullRequest': {
        const decoded = store.decodeGlobalId(str(input.pullRequestId));
        if (!decoded || decoded.kind !== 'PullRequest') return null;
        const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(decoded.ref);
        if (!m) return null;
        const repo = store.getRepo(m[1]!, m[2]!);
        const pull = repo?.pulls.find((p) => p.number === parseInt(m[3]!, 10));
        if (!repo || !pull) return null;
        const method = str(input.mergeMethod, 'SQUASH').toUpperCase();
        const res = mergePull(store, repo, pull, method);
        if (!res.ok) {
          ctx.errors.push({ message: res.reason ?? 'merge failed' });
          return null;
        }
        return selectFields(ctx, 'MergePullRequestPayload', f.selection, (g) => {
          if (g.name === 'pullRequest') return pullNode(ctx, repo, pull, g.selection);
          return null;
        });
      }
      case 'addComment': {
        const decoded = store.decodeGlobalId(str(input.subjectId));
        if (!decoded) return null;
        const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(decoded.ref);
        if (!m) return null;
        const repo = store.getRepo(m[1]!, m[2]!);
        const issue = repo?.issues.find((i) => i.number === parseInt(m[3]!, 10));
        if (!repo || !issue) return null;
        const comment = { id: repo.nextCommentId++, body: str(input.body), userLogin: store.viewer(), createdAt: isoNow() };
        issue.comments.push(comment);
        issue.updatedAt = isoNow();
        issue.cachedJson = '';
        const nodeId = store.globalId('IssueComment', `${m[1]}/${m[2]}#${issue.number}:${comment.id}`);
        return selectFields(ctx, 'AddCommentPayload', f.selection, (g) => {
          if (g.name === 'commentEdge') {
            return selectFields(ctx, 'IssueCommentEdge', g.selection, (h) => {
              if (h.name === 'node') {
                return selectFields(ctx, 'IssueComment', h.selection, (k) => {
                  if (k.name === 'id') return nodeId;
                  if (k.name === 'body') return comment.body;
                  return null;
                });
              }
              return null;
            });
          }
          return null;
        });
      }
      default:
        return null;
    }
  });
}

// ---------------------------------------------------------------- entry

export function handleGraphQL(ctx: ReqCtx): Resp {
  if (ctx.bodyError) return errResp(400, 'Problems parsing JSON');
  const docs: Array<{ query?: unknown; variables?: unknown }> = Array.isArray(ctx.body) ? ctx.body : [ctx.body];
  const answers: Array<Record<string, unknown>> = [];
  for (const doc of docs) {
    const query = typeof doc.query === 'string' ? doc.query : '';
    const variables = isRecord(doc.variables) ? (doc.variables as Record<string, unknown>) : {};
    const exec: ExecCtx = { store: ctx.store, variables, errors: [] };
    try {
      const ops = new Parser(lex(query)).parseDocument();
      if (ops.length === 0) {
        answers.push({ errors: [{ message: 'Empty document' }] });
        continue;
      }
      const data = executeOperation(exec, ops[0]!);
      const answer: Record<string, unknown> = { data };
      if (exec.errors.length > 0) answer.errors = exec.errors;
      answers.push(answer);
    } catch (err) {
      answers.push({ errors: [{ message: err instanceof Error ? err.message : 'parse error' }] });
    }
  }
  return jsonResp(200, Array.isArray(ctx.body) ? answers : answers[0]!);
}
