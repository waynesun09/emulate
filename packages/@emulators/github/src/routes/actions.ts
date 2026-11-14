import type { RouteContext, AuthUser, Context } from "@emulators/core";
import {
  ApiError,
  forbidden,
  parseJsonBody,
  parsePagination,
  setLinkHeader,
  unauthorized,
  validationError,
} from "@emulators/core";
import { getGitHubStore } from "../store.js";
import type { GitHubStore } from "../store.js";
import type {
  GitHubArtifact,
  GitHubJob,
  GitHubOrg,
  GitHubRepo,
  GitHubSecret,
  GitHubUser,
  GitHubVariable,
  GitHubWorkflow,
  GitHubWorkflowRun,
} from "../entities.js";
import { formatRepo, formatUser, generateNodeId, generateSha, lookupRepo, timestamp } from "../helpers.js";
import {
  assertAuthenticatedActor,
  assertRepoAdmin,
  assertAuthenticatedUser,
  assertRepoPermission,
  canAccessRepo,
  getActorUser,
  hasRepoAdmin,
  installationCanAccessRepo,
  isOrgMember,
  notFoundResponse,
  ownerLoginOf,
} from "../route-helpers.js";

function listOrgMembersDeduped(gh: GitHubStore, orgId: number): { user: GitHubUser; orgRole: "admin" | "member" }[] {
  const byUser = new Map<number, { user: GitHubUser; isAdmin: boolean }>();
  for (const team of gh.teams.findBy("org_id", orgId)) {
    for (const m of gh.teamMembers.findBy("team_id", team.id)) {
      const user = gh.users.get(m.user_id);
      if (!user) continue;
      const isAdmin = m.role === "maintainer";
      const prev = byUser.get(user.id);
      if (!prev) {
        byUser.set(user.id, { user, isAdmin });
      } else {
        byUser.set(user.id, { user, isAdmin: prev.isAdmin || isAdmin });
      }
    }
  }
  return [...byUser.values()]
    .map(({ user, isAdmin }) => ({
      user,
      orgRole: isAdmin ? ("admin" as const) : ("member" as const),
    }))
    .sort((a, b) => a.user.id - b.user.id);
}

function orgRoleForUser(gh: GitHubStore, orgId: number, userId: number): "admin" | "member" | null {
  const row = listOrgMembersDeduped(gh, orgId).find((r) => r.user.id === userId);
  return row?.orgRole ?? null;
}

function assertOrgAdmin(gh: GitHubStore, authUser: AuthUser | undefined, org: GitHubOrg) {
  if (!authUser) throw unauthorized();
  const user = getActorUser(gh, authUser);
  if (!user) throw unauthorized();
  if (orgRoleForUser(gh, org.id, user.id) === "admin") return;
  throw forbidden();
}

function getOrgByLogin(gh: GitHubStore, login: string): GitHubOrg | undefined {
  return gh.orgs.findOneBy("login", login);
}

function resolveWorkflow(gh: GitHubStore, repoId: number, param: string): GitHubWorkflow | undefined {
  const trimmed = param.trim();
  const asNum = parseInt(trimmed, 10);
  if (!Number.isNaN(asNum) && String(asNum) === trimmed) {
    const w = gh.workflows.get(asNum);
    if (w && w.repo_id === repoId) return w;
  }
  return gh.workflows
    .findBy("repo_id", repoId)
    .find((w) => w.path === trimmed || w.path.endsWith(`/${trimmed}`) || w.name === trimmed);
}

function resolveRefToBranchAndSha(gh: GitHubStore, repo: GitHubRepo, ref: string): { branch: string; sha: string } {
  const name = ref.replace(/^refs\/heads\//, "").replace(/^refs\/tags\//, "");
  const branch = gh.branches.findBy("repo_id", repo.id).find((b) => b.name === name);
  if (branch) return { branch: branch.name, sha: branch.sha };
  return { branch: name, sha: generateSha() };
}

function nextRunNumber(gh: GitHubStore, workflowId: number, repoId: number): number {
  const runs = gh.workflowRuns.findBy("workflow_id", workflowId).filter((r) => r.repo_id === repoId);
  return runs.reduce((m, r) => Math.max(m, r.run_number), 0) + 1;
}

function findRepoSecret(gh: GitHubStore, repoId: number, name: string): GitHubSecret | undefined {
  return gh.secrets.all().find((s) => s.repo_id === repoId && s.org_id === null && s.name === name);
}

function findOrgSecret(gh: GitHubStore, orgId: number, name: string): GitHubSecret | undefined {
  return gh.secrets.all().find((s) => s.org_id === orgId && s.repo_id === null && s.name === name);
}

function listRepoSecrets(gh: GitHubStore, repoId: number): GitHubSecret[] {
  return gh.secrets.all().filter((s) => s.repo_id === repoId && s.org_id === null);
}

function listOrgSecrets(gh: GitHubStore, orgId: number): GitHubSecret[] {
  return gh.secrets.all().filter((s) => s.org_id === orgId && s.repo_id === null);
}

const VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VARIABLE_VISIBILITIES = ["all", "private", "selected"] as const;
type VariableVisibility = (typeof VARIABLE_VISIBILITIES)[number];

// GitHub stores variable names in upper case and matches them case-insensitively.
function normalizeVariableName(value: unknown): string {
  if (typeof value !== "string" || !VARIABLE_NAME_PATTERN.test(value)) {
    throw validationError(
      "Variable names can only contain alphanumeric characters or underscores and must not start with a number",
    );
  }
  const name = value.toUpperCase();
  if (name.startsWith("GITHUB_")) throw validationError("Variable names must not start with the GITHUB_ prefix");
  return name;
}

function requireVariableValue(value: unknown): string {
  if (typeof value !== "string") throw validationError("Variable value is required");
  return value;
}

function parseVariableVisibility(value: unknown): VariableVisibility {
  if (typeof value !== "string" || !(VARIABLE_VISIBILITIES as readonly string[]).includes(value)) {
    throw validationError("Variable visibility must be one of: all, private, selected");
  }
  return value as VariableVisibility;
}

function findRepoVariable(gh: GitHubStore, repoId: number, name: string): GitHubVariable | undefined {
  const upper = name.toUpperCase();
  return gh.variables.findBy("repo_id", repoId).find((v) => v.org_id === null && v.name === upper);
}

function findOrgVariable(gh: GitHubStore, orgId: number, name: string): GitHubVariable | undefined {
  const upper = name.toUpperCase();
  return gh.variables.findBy("org_id", orgId).find((v) => v.repo_id === null && v.name === upper);
}

function listRepoVariables(gh: GitHubStore, repoId: number): GitHubVariable[] {
  return gh.variables
    .findBy("repo_id", repoId)
    .filter((v) => v.org_id === null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function listOrgVariables(gh: GitHubStore, orgId: number): GitHubVariable[] {
  return gh.variables
    .findBy("org_id", orgId)
    .filter((v) => v.repo_id === null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function orgVariablesForRepo(gh: GitHubStore, repo: GitHubRepo): GitHubVariable[] {
  if (repo.owner_type !== "Organization") return [];
  return listOrgVariables(gh, repo.owner_id).filter(
    (v) =>
      v.visibility === "all" ||
      (v.visibility === "private" && repo.private) ||
      (v.visibility === "selected" && v.selected_repository_ids.includes(repo.id)),
  );
}

function formatVariable(v: GitHubVariable) {
  return { name: v.name, value: v.value, created_at: v.created_at, updated_at: v.updated_at };
}

function formatOrgVariable(v: GitHubVariable, org: GitHubOrg, baseUrl: string) {
  return {
    ...formatVariable(v),
    visibility: v.visibility,
    ...(v.visibility === "selected"
      ? { selected_repositories_url: `${baseUrl}/orgs/${org.login}/actions/variables/${v.name}/repositories` }
      : {}),
  };
}

// GitHub pages variable lists with a default of 10 and a maximum of 30 per page.
function paginateVariables<T>(c: Context, items: T[]): T[] {
  const { page } = parsePagination(c);
  const requested = parseInt(c.req.query("per_page") ?? "10", 10) || 10;
  const perPage = Math.min(30, Math.max(1, requested));
  setLinkHeader(c, items.length, page, perPage);
  return items.slice((page - 1) * perPage, page * perPage);
}

function installationGrants(authUser: AuthUser, permission: string, required: "read" | "write"): boolean {
  const granted = authUser.installation?.permissions[permission];
  return required === "read" ? granted === "read" || granted === "write" : granted === "write";
}

function isRepoCollaborator(gh: GitHubStore, user: GitHubUser, repo: GitHubRepo): boolean {
  if (repo.owner_type === "User" && repo.owner_id === user.id) return true;
  if (repo.owner_type === "Organization" && isOrgMember(gh, user.id, repo.owner_id)) return true;
  return gh.collaborators.findBy("repo_id", repo.id).some((c) => c.user_id === user.id);
}

// Variable values are returned in plain text, so reads need collaborator access and writes need repository admin
// access, like secrets. Installation tokens need the actions_variables permission on a repository they can access.
function assertRepoVariablesAccess(
  gh: GitHubStore,
  authUser: AuthUser | undefined,
  repo: GitHubRepo,
  required: "read" | "write",
): void {
  if (authUser?.installation) {
    if (!installationCanAccessRepo(authUser, repo)) throw forbidden();
    if (!installationGrants(authUser, "actions_variables", required)) throw forbidden();
    return;
  }
  if (!canAccessRepo(gh, authUser, repo)) throw notFoundResponse();
  const user = assertAuthenticatedUser(gh, authUser);
  const allowed = required === "write" ? hasRepoAdmin(gh, user, repo) : isRepoCollaborator(gh, user, repo);
  if (!allowed) throw forbidden();
}

function assertOrgVariablesAccess(
  gh: GitHubStore,
  authUser: AuthUser | undefined,
  org: GitHubOrg,
  required: "read" | "write",
): void {
  const installation = authUser?.installation;
  if (installation) {
    if (installation.accountType !== "Organization" || installation.accountId !== org.id) throw forbidden();
    if (!installationGrants(authUser, "organization_actions_variables", required)) throw forbidden();
    return;
  }
  assertOrgAdmin(gh, authUser, org);
}

function parseSelectedRepositoryIds(gh: GitHubStore, org: GitHubOrg, value: unknown): number[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((id) => Number.isInteger(id))) {
    throw validationError("selected_repository_ids must be an array of repository IDs");
  }
  for (const id of value as number[]) assertOrgRepositoryId(gh, org, id);
  return [...new Set(value as number[])];
}

function assertOrgRepositoryId(gh: GitHubStore, org: GitHubOrg, id: number): GitHubRepo {
  const repo = Number.isInteger(id) ? gh.repos.get(id) : undefined;
  if (!repo || repo.owner_type !== "Organization" || repo.owner_id !== org.id) {
    throw validationError(`Repository ${id} is not in the ${org.login} organization`);
  }
  return repo;
}

function assertSelectedVisibility(v: GitHubVariable): void {
  if (v.visibility !== "selected") {
    throw new ApiError(409, "Visibility of the variable is not set to selected");
  }
}

function deleteJobsForRun(gh: GitHubStore, runId: number) {
  for (const j of gh.jobs.findBy("run_id", runId)) {
    gh.jobs.delete(j.id);
  }
}

function deleteArtifactsForRun(gh: GitHubStore, runId: number) {
  for (const a of gh.artifacts.findBy("run_id", runId)) {
    gh.artifacts.delete(a.id);
  }
}

function seedStubJobs(gh: GitHubStore, repo: GitHubRepo, run: GitHubWorkflowRun) {
  const job = gh.jobs.insert({
    node_id: "",
    repo_id: repo.id,
    run_id: run.id,
    name: "build",
    status: run.status === "completed" ? "completed" : "in_progress",
    conclusion: run.status === "completed" ? run.conclusion : null,
    started_at: run.run_started_at,
    completed_at: run.status === "completed" ? run.updated_at : null,
    runner_id: 1,
    runner_name: "Hosted Agent",
    steps: [
      {
        name: "Set up job",
        status: run.status === "completed" ? "completed" : "in_progress",
        conclusion: run.status === "completed" ? run.conclusion : null,
        number: 1,
        started_at: run.run_started_at,
        completed_at: run.status === "completed" ? run.updated_at : null,
      },
    ],
  } as Omit<GitHubJob, "id" | "created_at" | "updated_at">);
  gh.jobs.update(job.id, { node_id: generateNodeId("Job", job.id) });
}

function formatWorkflow(w: GitHubWorkflow, repo: GitHubRepo, gh: GitHubStore, baseUrl: string) {
  const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
  return {
    id: w.id,
    node_id: w.node_id,
    name: w.name,
    path: w.path,
    state: w.state,
    created_at: w.created_at,
    updated_at: w.updated_at,
    url: `${repoUrl}/actions/workflows/${w.id}`,
    html_url: `${baseUrl}/${repo.full_name}/blob/${repo.default_branch}/${w.path}`,
    badge_url:
      w.badge_url ||
      `${baseUrl}/${repo.full_name}/workflows/${encodeURIComponent(w.path.replace(/^\/.github\/workflows\//, ""))}/badge.svg`,
  };
}

function formatWorkflowRun(run: GitHubWorkflowRun, repo: GitHubRepo, gh: GitHubStore, baseUrl: string) {
  const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
  const wf = gh.workflows.get(run.workflow_id);
  const actor = gh.users.get(run.actor_id);
  const wfPath = wf?.path ?? ".github/workflows/main.yml";
  return {
    id: run.id,
    name: run.name,
    node_id: run.node_id,
    head_branch: run.head_branch,
    head_sha: run.head_sha,
    path: wfPath,
    display_title: run.name,
    run_number: run.run_number,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion,
    workflow_id: run.workflow_id,
    check_suite_id: null,
    url: `${repoUrl}/actions/runs/${run.id}`,
    html_url: `${baseUrl}/${repo.full_name}/actions/runs/${run.id}`,
    pull_requests: [],
    created_at: run.created_at,
    updated_at: run.updated_at,
    actor: actor ? formatUser(actor, baseUrl) : null,
    run_attempt: run.run_attempt,
    run_started_at: run.run_started_at,
    triggering_actor: actor ? formatUser(actor, baseUrl) : null,
    workflow_url: wf ? `${repoUrl}/actions/workflows/${wf.id}` : null,
    repository: formatRepo(repo, gh, baseUrl),
    head_commit: {
      id: run.head_sha,
      tree_id: generateSha(),
      message: "Workflow run",
      timestamp: run.created_at,
      author: actor
        ? { name: actor.login, email: `${actor.login}@users.noreply.github.com` }
        : { name: "unknown", email: "unknown@users.noreply.github.com" },
    },
  };
}

function formatJob(job: GitHubJob, repo: GitHubRepo, gh: GitHubStore, baseUrl: string) {
  const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
  const run = gh.workflowRuns.get(job.run_id);
  const headSha = run?.head_sha ?? "";
  return {
    id: job.id,
    run_id: job.run_id,
    workflow_name: run?.name ?? "workflow",
    head_branch: run?.head_branch ?? "",
    run_url: `${repoUrl}/actions/runs/${job.run_id}`,
    node_id: job.node_id,
    head_sha: headSha,
    status: job.status,
    conclusion: job.conclusion,
    started_at: job.started_at,
    completed_at: job.completed_at,
    name: job.name,
    steps: job.steps,
    url: `${repoUrl}/actions/jobs/${job.id}`,
    html_url: `${baseUrl}/${repo.full_name}/commit/${headSha}/checks`,
    check_run_url: `${baseUrl}/repos/${repo.full_name}/check-runs/${job.id}`,
    labels: ["hosted"],
    runner_id: job.runner_id,
    runner_name: job.runner_name,
    runner_group_id: 1,
    runner_group_name: "GitHub Actions",
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
}

function formatArtifact(a: GitHubArtifact, repo: GitHubRepo, gh: GitHubStore, baseUrl: string) {
  const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
  const run = gh.workflowRuns.get(a.run_id);
  return {
    id: a.id,
    node_id: a.node_id,
    name: a.name,
    size_in_bytes: a.size_in_bytes,
    url: `${repoUrl}/actions/artifacts/${a.id}`,
    archive_download_url: `${repoUrl}/actions/artifacts/${a.id}/zip`,
    expired: a.expired,
    digest: null,
    created_at: a.created_at,
    expires_at: a.expires_at,
    workflow_run: run
      ? {
          id: run.id,
          repository_id: repo.id,
          head_repository_id: repo.id,
          head_branch: run.head_branch,
          head_sha: run.head_sha,
        }
      : null,
  };
}

function filterRuns(
  gh: GitHubStore,
  runs: GitHubWorkflowRun[],
  q: { actor?: string; branch?: string; event?: string; status?: string },
) {
  let out = runs;
  if (q.actor) {
    const u = gh.users.findOneBy("login", q.actor);
    out = u ? out.filter((r) => r.actor_id === u.id) : [];
  }
  if (q.branch) {
    out = out.filter((r) => r.head_branch === q.branch);
  }
  if (q.event) {
    out = out.filter((r) => r.event === q.event);
  }
  if (q.status) {
    out = out.filter((r) => r.status === q.status);
  }
  return out.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function actionsRoutes({ app, store, webhooks, baseUrl }: RouteContext): void {
  const gh = getGitHubStore(store);

  app.get("/repos/:owner/:repo/actions/workflows", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoPermission(gh, c.get("authUser"), repo, "actions");
    const workflows = gh.workflows.findBy("repo_id", repo.id).sort((a, b) => a.path.localeCompare(b.path));
    return c.json({
      total_count: workflows.length,
      workflows: workflows.map((w) => formatWorkflow(w, repo, gh, baseUrl)),
    });
  });

  app.get("/repos/:owner/:repo/actions/workflows/:workflow_id", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoPermission(gh, c.get("authUser"), repo, "actions");
    const w = resolveWorkflow(gh, repo.id, c.req.param("workflow_id")!);
    if (!w) throw notFoundResponse();
    return c.json(formatWorkflow(w, repo, gh, baseUrl));
  });

  app.put("/repos/:owner/:repo/actions/workflows/:workflow_id/disable", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoAdmin(gh, c.get("authUser"), repo);
    const w = resolveWorkflow(gh, repo.id, c.req.param("workflow_id")!);
    if (!w) throw notFoundResponse();
    gh.workflows.update(w.id, { state: "disabled_manually" });
    return c.body(null, 204);
  });

  app.put("/repos/:owner/:repo/actions/workflows/:workflow_id/enable", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoAdmin(gh, c.get("authUser"), repo);
    const w = resolveWorkflow(gh, repo.id, c.req.param("workflow_id")!);
    if (!w) throw notFoundResponse();
    gh.workflows.update(w.id, { state: "active" });
    return c.body(null, 204);
  });

  app.post("/repos/:owner/:repo/actions/workflows/:workflow_id/dispatches", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    const authUser = c.get("authUser");
    assertRepoPermission(gh, authUser, repo, "actions", "write");
    const actor = assertAuthenticatedActor(gh, authUser);
    const w = resolveWorkflow(gh, repo.id, c.req.param("workflow_id")!);
    if (!w) throw notFoundResponse();
    if (w.state !== "active") {
      throw new ApiError(422, "Workflow is not active");
    }
    const body = await parseJsonBody(c);
    const ref = typeof body.ref === "string" ? body.ref : repo.default_branch;
    const { branch, sha } = resolveRefToBranchAndSha(gh, repo, ref);
    const now = timestamp();
    const runNumber = nextRunNumber(gh, w.id, repo.id);
    const run = gh.workflowRuns.insert({
      node_id: "",
      repo_id: repo.id,
      workflow_id: w.id,
      name: w.name,
      head_branch: branch,
      head_sha: sha,
      run_number: runNumber,
      event: "workflow_dispatch",
      status: "queued",
      conclusion: null,
      actor_id: actor.id,
      run_attempt: 1,
      run_started_at: now,
    } as Omit<GitHubWorkflowRun, "id" | "created_at" | "updated_at">);
    gh.workflowRuns.update(run.id, { node_id: generateNodeId("WorkflowRun", run.id) });
    const created = gh.workflowRuns.get(run.id)!;
    seedStubJobs(gh, repo, created);
    const ownerLogin = ownerLoginOf(gh, repo);
    void webhooks.dispatch(
      "workflow_dispatch",
      undefined,
      {
        ref: `refs/heads/${branch}`,
        inputs: typeof body.inputs === "object" && body.inputs ? body.inputs : {},
        workflow: formatWorkflow(w, repo, gh, baseUrl),
        repository: formatRepo(repo, gh, baseUrl),
        sender: formatUser(actor, baseUrl),
      },
      ownerLogin,
      repo.name,
    );
    void webhooks.dispatch(
      "workflow_run",
      "requested",
      {
        workflow_run: formatWorkflowRun(created, repo, gh, baseUrl),
        repository: formatRepo(repo, gh, baseUrl),
        sender: formatUser(actor, baseUrl),
      },
      ownerLogin,
      repo.name,
    );
    return c.body(null, 204);
  });

  app.get("/repos/:owner/:repo/actions/runs", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoPermission(gh, c.get("authUser"), repo, "actions");
    const { page, per_page } = parsePagination(c);
    const actor = c.req.query("actor") ?? undefined;
    const branch = c.req.query("branch") ?? undefined;
    const event = c.req.query("event") ?? undefined;
    const status = c.req.query("status") ?? undefined;
    const all = gh.workflowRuns.findBy("repo_id", repo.id);
    const filtered = filterRuns(gh, all, { actor, branch, event, status });
    const total = filtered.length;
    const slice = filtered.slice((page - 1) * per_page, (page - 1) * per_page + per_page);
    setLinkHeader(c, total, page, per_page);
    return c.json({
      total_count: total,
      workflow_runs: slice.map((r) => formatWorkflowRun(r, repo, gh, baseUrl)),
    });
  });

  app.get("/repos/:owner/:repo/actions/runs/:run_id", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoPermission(gh, c.get("authUser"), repo, "actions");
    const runId = parseInt(c.req.param("run_id")!, 10);
    const run = gh.workflowRuns.get(runId);
    if (!run || run.repo_id !== repo.id) throw notFoundResponse();
    return c.json(formatWorkflowRun(run, repo, gh, baseUrl));
  });

  app.get("/repos/:owner/:repo/actions/workflows/:workflow_id/runs", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoPermission(gh, c.get("authUser"), repo, "actions");
    const w = resolveWorkflow(gh, repo.id, c.req.param("workflow_id")!);
    if (!w) throw notFoundResponse();
    const { page, per_page } = parsePagination(c);
    const actor = c.req.query("actor") ?? undefined;
    const branch = c.req.query("branch") ?? undefined;
    const event = c.req.query("event") ?? undefined;
    const status = c.req.query("status") ?? undefined;
    const all = gh.workflowRuns.findBy("repo_id", repo.id).filter((r) => r.workflow_id === w.id);
    const filtered = filterRuns(gh, all, { actor, branch, event, status });
    const total = filtered.length;
    const slice = filtered.slice((page - 1) * per_page, (page - 1) * per_page + per_page);
    setLinkHeader(c, total, page, per_page);
    return c.json({
      total_count: total,
      workflow_runs: slice.map((r) => formatWorkflowRun(r, repo, gh, baseUrl)),
    });
  });

  app.post("/repos/:owner/:repo/actions/runs/:run_id/cancel", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoPermission(gh, c.get("authUser"), repo, "actions", "write");
    const runId = parseInt(c.req.param("run_id")!, 10);
    const run = gh.workflowRuns.get(runId);
    if (!run || run.repo_id !== repo.id) throw notFoundResponse();
    gh.workflowRuns.update(run.id, { status: "completed", conclusion: "cancelled" });
    const updated = gh.workflowRuns.get(run.id)!;
    const ownerLogin = ownerLoginOf(gh, repo);
    const actor = gh.users.get(run.actor_id);
    void webhooks.dispatch(
      "workflow_run",
      "completed",
      {
        workflow_run: formatWorkflowRun(updated, repo, gh, baseUrl),
        repository: formatRepo(repo, gh, baseUrl),
        sender: actor ? formatUser(actor, baseUrl) : null,
      },
      ownerLogin,
      repo.name,
    );
    return c.body(null, 202);
  });

  app.post("/repos/:owner/:repo/actions/runs/:run_id/rerun", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoPermission(gh, c.get("authUser"), repo, "actions", "write");
    const runId = parseInt(c.req.param("run_id")!, 10);
    const parent = gh.workflowRuns.get(runId);
    if (!parent || parent.repo_id !== repo.id) throw notFoundResponse();
    const wf = gh.workflows.get(parent.workflow_id);
    if (!wf) throw notFoundResponse();
    const now = timestamp();
    const runNumber = nextRunNumber(gh, wf.id, repo.id);
    const run = gh.workflowRuns.insert({
      node_id: "",
      repo_id: repo.id,
      workflow_id: wf.id,
      name: parent.name,
      head_branch: parent.head_branch,
      head_sha: parent.head_sha,
      run_number: runNumber,
      event: parent.event,
      status: "queued",
      conclusion: null,
      actor_id: parent.actor_id,
      run_attempt: parent.run_attempt + 1,
      run_started_at: now,
    } as Omit<GitHubWorkflowRun, "id" | "created_at" | "updated_at">);
    gh.workflowRuns.update(run.id, { node_id: generateNodeId("WorkflowRun", run.id) });
    const created = gh.workflowRuns.get(run.id)!;
    seedStubJobs(gh, repo, created);
    const ownerLogin = ownerLoginOf(gh, repo);
    const actor = gh.users.get(created.actor_id);
    void webhooks.dispatch(
      "workflow_run",
      "requested",
      {
        workflow_run: formatWorkflowRun(created, repo, gh, baseUrl),
        repository: formatRepo(repo, gh, baseUrl),
        sender: actor ? formatUser(actor, baseUrl) : null,
      },
      ownerLogin,
      repo.name,
    );
    return c.json(formatWorkflowRun(created, repo, gh, baseUrl), 201);
  });

  app.delete("/repos/:owner/:repo/actions/runs/:run_id", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoAdmin(gh, c.get("authUser"), repo);
    const runId = parseInt(c.req.param("run_id")!, 10);
    const run = gh.workflowRuns.get(runId);
    if (!run || run.repo_id !== repo.id) throw notFoundResponse();
    deleteArtifactsForRun(gh, run.id);
    deleteJobsForRun(gh, run.id);
    gh.workflowRuns.delete(run.id);
    return c.body(null, 204);
  });

  app.get("/repos/:owner/:repo/actions/runs/:run_id/logs", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoPermission(gh, c.get("authUser"), repo, "actions");
    const runId = parseInt(c.req.param("run_id")!, 10);
    const run = gh.workflowRuns.get(runId);
    if (!run || run.repo_id !== repo.id) throw notFoundResponse();
    return c.text(`2025-01-01T00:00:00.0000000Z Workflow run ${run.id} logs (stub)\n${run.head_sha}\n`, 200, {
      "Content-Type": "text/plain; charset=utf-8",
    });
  });

  app.get("/repos/:owner/:repo/actions/runs/:run_id/jobs", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoPermission(gh, c.get("authUser"), repo, "actions");
    const runId = parseInt(c.req.param("run_id")!, 10);
    const run = gh.workflowRuns.get(runId);
    if (!run || run.repo_id !== repo.id) throw notFoundResponse();
    const jobs = gh.jobs.findBy("run_id", runId).filter((j) => j.repo_id === repo.id);
    return c.json({
      total_count: jobs.length,
      jobs: jobs.map((j) => formatJob(j, repo, gh, baseUrl)),
    });
  });

  app.get("/repos/:owner/:repo/actions/jobs/:job_id", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoPermission(gh, c.get("authUser"), repo, "actions");
    const jobId = parseInt(c.req.param("job_id")!, 10);
    const job = gh.jobs.get(jobId);
    if (!job || job.repo_id !== repo.id) throw notFoundResponse();
    return c.json(formatJob(job, repo, gh, baseUrl));
  });

  app.get("/repos/:owner/:repo/actions/jobs/:job_id/logs", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoPermission(gh, c.get("authUser"), repo, "actions");
    const jobId = parseInt(c.req.param("job_id")!, 10);
    const job = gh.jobs.get(jobId);
    if (!job || job.repo_id !== repo.id) throw notFoundResponse();
    return c.text(`2025-01-01T00:00:00.0000000Z Job ${job.id} logs (stub)\n`, 200, {
      "Content-Type": "text/plain; charset=utf-8",
    });
  });

  app.get("/repos/:owner/:repo/actions/artifacts", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoPermission(gh, c.get("authUser"), repo, "actions");
    const { page, per_page } = parsePagination(c);
    const all = gh.artifacts.findBy("repo_id", repo.id).sort((a, b) => b.created_at.localeCompare(a.created_at));
    const total = all.length;
    const slice = all.slice((page - 1) * per_page, (page - 1) * per_page + per_page);
    setLinkHeader(c, total, page, per_page);
    return c.json({
      total_count: total,
      artifacts: slice.map((a) => formatArtifact(a, repo, gh, baseUrl)),
    });
  });

  app.get("/repos/:owner/:repo/actions/runs/:run_id/artifacts", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoPermission(gh, c.get("authUser"), repo, "actions");
    const runId = parseInt(c.req.param("run_id")!, 10);
    const run = gh.workflowRuns.get(runId);
    if (!run || run.repo_id !== repo.id) throw notFoundResponse();
    const arts = gh.artifacts.findBy("run_id", runId).filter((a) => a.repo_id === repo.id);
    return c.json({
      total_count: arts.length,
      artifacts: arts.map((a) => formatArtifact(a, repo, gh, baseUrl)),
    });
  });

  app.get("/repos/:owner/:repo/actions/artifacts/:artifact_id", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoPermission(gh, c.get("authUser"), repo, "actions");
    const artifactId = parseInt(c.req.param("artifact_id")!, 10);
    const a = gh.artifacts.get(artifactId);
    if (!a || a.repo_id !== repo.id) throw notFoundResponse();
    return c.json(formatArtifact(a, repo, gh, baseUrl));
  });

  app.delete("/repos/:owner/:repo/actions/artifacts/:artifact_id", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoAdmin(gh, c.get("authUser"), repo);
    const artifactId = parseInt(c.req.param("artifact_id")!, 10);
    const a = gh.artifacts.get(artifactId);
    if (!a || a.repo_id !== repo.id) throw notFoundResponse();
    gh.artifacts.delete(a.id);
    return c.body(null, 204);
  });

  app.get("/repos/:owner/:repo/actions/secrets", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoPermission(gh, c.get("authUser"), repo, "secrets");
    const secrets = listRepoSecrets(gh, repo.id).sort((a, b) => a.name.localeCompare(b.name));
    return c.json({
      total_count: secrets.length,
      secrets: secrets.map((s) => ({
        name: s.name,
        created_at: s.created_at,
        updated_at: s.updated_at,
      })),
    });
  });

  app.get("/repos/:owner/:repo/actions/secrets/:secret_name", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoPermission(gh, c.get("authUser"), repo, "secrets");
    const name = c.req.param("secret_name")!;
    const s = findRepoSecret(gh, repo.id, name);
    if (!s) throw notFoundResponse();
    return c.json({
      name: s.name,
      visibility: s.visibility,
      created_at: s.created_at,
      updated_at: s.updated_at,
    });
  });

  app.put("/repos/:owner/:repo/actions/secrets/:secret_name", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoAdmin(gh, c.get("authUser"), repo);
    await parseJsonBody(c);
    const name = c.req.param("secret_name")!;
    const existing = findRepoSecret(gh, repo.id, name);
    if (existing) {
      gh.secrets.update(existing.id, { visibility: existing.visibility });
      return c.body(null, 204);
    }
    gh.secrets.insert({
      repo_id: repo.id,
      org_id: null,
      name,
      visibility: "all",
    } as Omit<GitHubSecret, "id" | "created_at" | "updated_at">);
    return c.body(null, 201);
  });

  app.delete("/repos/:owner/:repo/actions/secrets/:secret_name", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoAdmin(gh, c.get("authUser"), repo);
    const name = c.req.param("secret_name")!;
    const s = findRepoSecret(gh, repo.id, name);
    if (!s) throw notFoundResponse();
    gh.secrets.delete(s.id);
    return c.body(null, 204);
  });

  app.get("/orgs/:org/actions/secrets", (c) => {
    const orgLogin = c.req.param("org")!;
    const org = getOrgByLogin(gh, orgLogin);
    if (!org) throw notFoundResponse();
    assertOrgAdmin(gh, c.get("authUser"), org);
    const secrets = listOrgSecrets(gh, org.id).sort((a, b) => a.name.localeCompare(b.name));
    return c.json({
      total_count: secrets.length,
      secrets: secrets.map((s) => ({
        name: s.name,
        created_at: s.created_at,
        updated_at: s.updated_at,
      })),
    });
  });

  app.get("/orgs/:org/actions/secrets/:secret_name", (c) => {
    const orgLogin = c.req.param("org")!;
    const org = getOrgByLogin(gh, orgLogin);
    if (!org) throw notFoundResponse();
    assertOrgAdmin(gh, c.get("authUser"), org);
    const name = c.req.param("secret_name")!;
    const s = findOrgSecret(gh, org.id, name);
    if (!s) throw notFoundResponse();
    return c.json({
      name: s.name,
      visibility: s.visibility,
      created_at: s.created_at,
      updated_at: s.updated_at,
    });
  });

  app.put("/orgs/:org/actions/secrets/:secret_name", async (c) => {
    const orgLogin = c.req.param("org")!;
    const org = getOrgByLogin(gh, orgLogin);
    if (!org) throw notFoundResponse();
    assertOrgAdmin(gh, c.get("authUser"), org);
    await parseJsonBody(c);
    const name = c.req.param("secret_name")!;
    const existing = findOrgSecret(gh, org.id, name);
    if (existing) {
      gh.secrets.update(existing.id, { visibility: existing.visibility });
      return c.body(null, 204);
    }
    gh.secrets.insert({
      repo_id: null,
      org_id: org.id,
      name,
      visibility: "all",
    } as Omit<GitHubSecret, "id" | "created_at" | "updated_at">);
    return c.body(null, 201);
  });

  app.delete("/orgs/:org/actions/secrets/:secret_name", (c) => {
    const orgLogin = c.req.param("org")!;
    const org = getOrgByLogin(gh, orgLogin);
    if (!org) throw notFoundResponse();
    assertOrgAdmin(gh, c.get("authUser"), org);
    const name = c.req.param("secret_name")!;
    const s = findOrgSecret(gh, org.id, name);
    if (!s) throw notFoundResponse();
    gh.secrets.delete(s.id);
    return c.body(null, 204);
  });

  app.get("/repos/:owner/:repo/actions/variables", (c) => {
    const repo = lookupRepo(gh, c.req.param("owner")!, c.req.param("repo")!);
    if (!repo) throw notFoundResponse();
    assertRepoVariablesAccess(gh, c.get("authUser"), repo, "read");
    const variables = listRepoVariables(gh, repo.id);
    return c.json({ total_count: variables.length, variables: paginateVariables(c, variables).map(formatVariable) });
  });

  app.post("/repos/:owner/:repo/actions/variables", async (c) => {
    const repo = lookupRepo(gh, c.req.param("owner")!, c.req.param("repo")!);
    if (!repo) throw notFoundResponse();
    assertRepoVariablesAccess(gh, c.get("authUser"), repo, "write");
    const body = await parseJsonBody(c);
    const name = normalizeVariableName(body.name);
    const value = requireVariableValue(body.value);
    if (findRepoVariable(gh, repo.id, name)) throw new ApiError(409, "Variable already exists");
    gh.variables.insert({
      repo_id: repo.id,
      org_id: null,
      name,
      value,
      visibility: "all",
      selected_repository_ids: [],
    });
    return c.body(null, 201);
  });

  app.get("/repos/:owner/:repo/actions/variables/:name", (c) => {
    const repo = lookupRepo(gh, c.req.param("owner")!, c.req.param("repo")!);
    if (!repo) throw notFoundResponse();
    assertRepoVariablesAccess(gh, c.get("authUser"), repo, "read");
    const v = findRepoVariable(gh, repo.id, c.req.param("name")!);
    if (!v) throw notFoundResponse();
    return c.json(formatVariable(v));
  });

  app.patch("/repos/:owner/:repo/actions/variables/:name", async (c) => {
    const repo = lookupRepo(gh, c.req.param("owner")!, c.req.param("repo")!);
    if (!repo) throw notFoundResponse();
    assertRepoVariablesAccess(gh, c.get("authUser"), repo, "write");
    const v = findRepoVariable(gh, repo.id, c.req.param("name")!);
    if (!v) throw notFoundResponse();
    const body = await parseJsonBody(c);
    const update: Partial<GitHubVariable> = {};
    if (body.name !== undefined) {
      const name = normalizeVariableName(body.name);
      const clash = findRepoVariable(gh, repo.id, name);
      if (clash && clash.id !== v.id) throw new ApiError(409, "Variable already exists");
      update.name = name;
    }
    if (body.value !== undefined) update.value = requireVariableValue(body.value);
    gh.variables.update(v.id, update);
    return c.body(null, 204);
  });

  app.delete("/repos/:owner/:repo/actions/variables/:name", (c) => {
    const repo = lookupRepo(gh, c.req.param("owner")!, c.req.param("repo")!);
    if (!repo) throw notFoundResponse();
    assertRepoVariablesAccess(gh, c.get("authUser"), repo, "write");
    const v = findRepoVariable(gh, repo.id, c.req.param("name")!);
    if (!v) throw notFoundResponse();
    gh.variables.delete(v.id);
    return c.body(null, 204);
  });

  app.get("/repos/:owner/:repo/actions/organization-variables", (c) => {
    const repo = lookupRepo(gh, c.req.param("owner")!, c.req.param("repo")!);
    if (!repo) throw notFoundResponse();
    assertRepoVariablesAccess(gh, c.get("authUser"), repo, "read");
    const variables = orgVariablesForRepo(gh, repo);
    return c.json({ total_count: variables.length, variables: paginateVariables(c, variables).map(formatVariable) });
  });

  app.get("/orgs/:org/actions/variables", (c) => {
    const org = getOrgByLogin(gh, c.req.param("org")!);
    if (!org) throw notFoundResponse();
    assertOrgVariablesAccess(gh, c.get("authUser"), org, "read");
    const variables = listOrgVariables(gh, org.id);
    return c.json({
      total_count: variables.length,
      variables: paginateVariables(c, variables).map((v) => formatOrgVariable(v, org, baseUrl)),
    });
  });

  app.post("/orgs/:org/actions/variables", async (c) => {
    const org = getOrgByLogin(gh, c.req.param("org")!);
    if (!org) throw notFoundResponse();
    assertOrgVariablesAccess(gh, c.get("authUser"), org, "write");
    const body = await parseJsonBody(c);
    const name = normalizeVariableName(body.name);
    const value = requireVariableValue(body.value);
    const visibility = parseVariableVisibility(body.visibility);
    const selected = parseSelectedRepositoryIds(gh, org, body.selected_repository_ids);
    if (findOrgVariable(gh, org.id, name)) throw new ApiError(409, "Variable already exists");
    gh.variables.insert({
      repo_id: null,
      org_id: org.id,
      name,
      value,
      visibility,
      selected_repository_ids: visibility === "selected" ? selected : [],
    });
    return c.body(null, 201);
  });

  app.get("/orgs/:org/actions/variables/:name", (c) => {
    const org = getOrgByLogin(gh, c.req.param("org")!);
    if (!org) throw notFoundResponse();
    assertOrgVariablesAccess(gh, c.get("authUser"), org, "read");
    const v = findOrgVariable(gh, org.id, c.req.param("name")!);
    if (!v) throw notFoundResponse();
    return c.json(formatOrgVariable(v, org, baseUrl));
  });

  app.patch("/orgs/:org/actions/variables/:name", async (c) => {
    const org = getOrgByLogin(gh, c.req.param("org")!);
    if (!org) throw notFoundResponse();
    assertOrgVariablesAccess(gh, c.get("authUser"), org, "write");
    const v = findOrgVariable(gh, org.id, c.req.param("name")!);
    if (!v) throw notFoundResponse();
    const body = await parseJsonBody(c);
    const update: Partial<GitHubVariable> = {};
    if (body.name !== undefined) {
      const name = normalizeVariableName(body.name);
      const clash = findOrgVariable(gh, org.id, name);
      if (clash && clash.id !== v.id) throw new ApiError(409, "Variable already exists");
      update.name = name;
    }
    if (body.value !== undefined) update.value = requireVariableValue(body.value);
    const visibility = body.visibility !== undefined ? parseVariableVisibility(body.visibility) : v.visibility;
    update.visibility = visibility;
    if (visibility !== "selected") {
      update.selected_repository_ids = [];
    } else if (body.selected_repository_ids !== undefined) {
      update.selected_repository_ids = parseSelectedRepositoryIds(gh, org, body.selected_repository_ids);
    }
    gh.variables.update(v.id, update);
    return c.body(null, 204);
  });

  app.delete("/orgs/:org/actions/variables/:name", (c) => {
    const org = getOrgByLogin(gh, c.req.param("org")!);
    if (!org) throw notFoundResponse();
    assertOrgVariablesAccess(gh, c.get("authUser"), org, "write");
    const v = findOrgVariable(gh, org.id, c.req.param("name")!);
    if (!v) throw notFoundResponse();
    gh.variables.delete(v.id);
    return c.body(null, 204);
  });

  app.get("/orgs/:org/actions/variables/:name/repositories", (c) => {
    const org = getOrgByLogin(gh, c.req.param("org")!);
    if (!org) throw notFoundResponse();
    assertOrgVariablesAccess(gh, c.get("authUser"), org, "read");
    const v = findOrgVariable(gh, org.id, c.req.param("name")!);
    if (!v) throw notFoundResponse();
    assertSelectedVisibility(v);
    const repos = v.selected_repository_ids
      .map((id) => gh.repos.get(id))
      .filter((r): r is GitHubRepo => r !== undefined)
      .sort((a, b) => a.id - b.id);
    const { page, per_page } = parsePagination(c);
    setLinkHeader(c, repos.length, page, per_page);
    return c.json({
      total_count: repos.length,
      repositories: repos.slice((page - 1) * per_page, page * per_page).map((r) => formatRepo(r, gh, baseUrl)),
    });
  });

  app.put("/orgs/:org/actions/variables/:name/repositories", async (c) => {
    const org = getOrgByLogin(gh, c.req.param("org")!);
    if (!org) throw notFoundResponse();
    assertOrgVariablesAccess(gh, c.get("authUser"), org, "write");
    const v = findOrgVariable(gh, org.id, c.req.param("name")!);
    if (!v) throw notFoundResponse();
    assertSelectedVisibility(v);
    const body = await parseJsonBody(c);
    if (body.selected_repository_ids === undefined) throw validationError("selected_repository_ids is required");
    gh.variables.update(v.id, {
      selected_repository_ids: parseSelectedRepositoryIds(gh, org, body.selected_repository_ids),
    });
    return c.body(null, 204);
  });

  app.put("/orgs/:org/actions/variables/:name/repositories/:repository_id", (c) => {
    const org = getOrgByLogin(gh, c.req.param("org")!);
    if (!org) throw notFoundResponse();
    assertOrgVariablesAccess(gh, c.get("authUser"), org, "write");
    const v = findOrgVariable(gh, org.id, c.req.param("name")!);
    if (!v) throw notFoundResponse();
    assertSelectedVisibility(v);
    const repo = assertOrgRepositoryId(gh, org, Number(c.req.param("repository_id")));
    if (!v.selected_repository_ids.includes(repo.id)) {
      gh.variables.update(v.id, { selected_repository_ids: [...v.selected_repository_ids, repo.id] });
    }
    return c.body(null, 204);
  });

  app.delete("/orgs/:org/actions/variables/:name/repositories/:repository_id", (c) => {
    const org = getOrgByLogin(gh, c.req.param("org")!);
    if (!org) throw notFoundResponse();
    assertOrgVariablesAccess(gh, c.get("authUser"), org, "write");
    const v = findOrgVariable(gh, org.id, c.req.param("name")!);
    if (!v) throw notFoundResponse();
    assertSelectedVisibility(v);
    const repo = assertOrgRepositoryId(gh, org, Number(c.req.param("repository_id")));
    gh.variables.update(v.id, {
      selected_repository_ids: v.selected_repository_ids.filter((id) => id !== repo.id),
    });
    return c.body(null, 204);
  });
}
