import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "@emulators/core";
import { Store } from "@emulators/core";
import { WebhookDispatcher } from "@emulators/core";
import { authMiddleware, createApiErrorHandler, createErrorHandler, type TokenMap } from "@emulators/core";
import { getGitHubStore, githubPlugin, seedFromConfig, type GitHubSeedConfig } from "../index.js";

const base = "http://localhost:4000";

const seedConfig: GitHubSeedConfig = {
  users: [{ login: "octocat" }, { login: "org-member" }, { login: "outsider" }, { login: "reader" }],
  orgs: [
    {
      login: "my-org",
      members: [{ login: "octocat", role: "admin" }, { login: "org-member" }],
      variables: [
        { name: "SEEDED_ALL", value: "everyone" },
        { name: "SEEDED_SELECTED", value: "chosen", visibility: "selected", selected_repositories: ["org-repo"] },
      ],
    },
  ],
  repos: [
    { owner: "octocat", name: "hello-world", variables: [{ name: "SEEDED_REPO_VAR", value: "seeded" }] },
    { owner: "octocat", name: "secret-repo", private: true },
    { owner: "my-org", name: "org-repo", private: true },
    { owner: "my-org", name: "public-repo" },
  ],
};

interface VariableBody {
  name: string;
  value: string;
  created_at: string;
  updated_at: string;
  visibility?: string;
  selected_repositories_url?: string;
}

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map([
    ["owner-token", { login: "octocat", id: 1, scopes: ["repo", "admin:org"] }],
    ["member-token", { login: "org-member", id: 2, scopes: ["repo"] }],
    ["outsider-token", { login: "outsider", id: 3, scopes: ["repo"] }],
    ["reader-token", { login: "reader", id: 4, scopes: ["repo"] }],
  ]);

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  githubPlugin.register(app as any, store, webhooks, base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, seedConfig);

  const gh = getGitHubStore(store);
  const repoId = (fullName: string) => gh.repos.findOneBy("full_name", fullName)!.id;
  const org = gh.orgs.findOneBy("login", "my-org")!;
  const reader = gh.users.findOneBy("login", "reader")!;
  gh.collaborators.insert({ repo_id: repoId("octocat/hello-world"), user_id: reader.id, permission: "pull" });

  const installation = (
    permissions: Record<string, string>,
    accountId: number,
    accountType: "User" | "Organization",
  ) => ({
    login: "vars-app[bot]",
    id: 900,
    scopes: [],
    installation: {
      installationId: 77,
      appId: 7,
      accountId,
      accountType,
      permissions,
      repositoryIds: [],
      repositorySelection: "all" as const,
    },
  });
  const octocat = gh.users.findOneBy("login", "octocat")!;
  tokenMap.set("inst-repo-write", installation({ actions_variables: "write" }, octocat.id, "User"));
  tokenMap.set("inst-repo-read", installation({ actions_variables: "read" }, octocat.id, "User"));
  tokenMap.set("inst-repo-none", installation({ secrets: "write", administration: "write" }, octocat.id, "User"));
  tokenMap.set("inst-org-write", installation({ organization_actions_variables: "write" }, org.id, "Organization"));
  tokenMap.set("inst-org-read", installation({ organization_actions_variables: "read" }, org.id, "Organization"));
  tokenMap.set("inst-org-none", installation({ actions_variables: "write" }, org.id, "Organization"));

  return { app, store, repoId };
}

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function json(token: string): Record<string, string> {
  return { ...auth(token), "Content-Type": "application/json" };
}

describe("GitHub Actions repository variables", () => {
  let app: Hono;

  beforeEach(() => {
    ({ app } = createTestApp());
  });

  it("creates, lists, gets, renames, updates, and deletes a variable", async () => {
    const url = `${base}/repos/octocat/hello-world/actions/variables`;
    const created = await app.request(url, {
      method: "POST",
      headers: json("owner-token"),
      body: JSON.stringify({ name: "MY_VAR", value: "one" }),
    });
    expect(created.status).toBe(201);

    const list = await app.request(url, { headers: auth("owner-token") });
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { total_count: number; variables: VariableBody[] };
    expect(listed.total_count).toBe(2);
    expect(listed.variables.map((v) => [v.name, v.value])).toEqual([
      ["MY_VAR", "one"],
      ["SEEDED_REPO_VAR", "seeded"],
    ]);
    expect(listed.variables[0]).toEqual({
      name: "MY_VAR",
      value: "one",
      created_at: expect.any(String),
      updated_at: expect.any(String),
    });

    const got = await app.request(`${url}/MY_VAR`, { headers: auth("owner-token") });
    expect(got.status).toBe(200);
    expect(((await got.json()) as VariableBody).value).toBe("one");

    const patched = await app.request(`${url}/MY_VAR`, {
      method: "PATCH",
      headers: json("owner-token"),
      body: JSON.stringify({ name: "RENAMED", value: "two" }),
    });
    expect(patched.status).toBe(204);
    expect((await app.request(`${url}/MY_VAR`, { headers: auth("owner-token") })).status).toBe(404);
    const renamed = await app.request(`${url}/RENAMED`, { headers: auth("owner-token") });
    expect(((await renamed.json()) as VariableBody).value).toBe("two");

    const valueOnly = await app.request(`${url}/RENAMED`, {
      method: "PATCH",
      headers: json("owner-token"),
      body: JSON.stringify({ value: "three" }),
    });
    expect(valueOnly.status).toBe(204);
    const afterValue = await app.request(`${url}/RENAMED`, { headers: auth("owner-token") });
    expect(((await afterValue.json()) as VariableBody).value).toBe("three");

    const deleted = await app.request(`${url}/RENAMED`, { method: "DELETE", headers: auth("owner-token") });
    expect(deleted.status).toBe(204);
    expect((await app.request(`${url}/RENAMED`, { headers: auth("owner-token") })).status).toBe(404);
  });

  it("returns 404 for missing variables and repositories", async () => {
    const url = `${base}/repos/octocat/hello-world/actions/variables`;
    expect((await app.request(`${url}/NOPE`, { headers: auth("owner-token") })).status).toBe(404);
    const patch = await app.request(`${url}/NOPE`, {
      method: "PATCH",
      headers: json("owner-token"),
      body: JSON.stringify({ value: "x" }),
    });
    expect(patch.status).toBe(404);
    expect((await app.request(`${url}/NOPE`, { method: "DELETE", headers: auth("owner-token") })).status).toBe(404);
    expect(
      (await app.request(`${base}/repos/octocat/missing/actions/variables`, { headers: auth("owner-token") })).status,
    ).toBe(404);
  });

  it("rejects duplicate creates and renames with 409, matching names case-insensitively", async () => {
    const url = `${base}/repos/octocat/hello-world/actions/variables`;
    const duplicate = await app.request(url, {
      method: "POST",
      headers: json("owner-token"),
      body: JSON.stringify({ name: "seeded_repo_var", value: "again" }),
    });
    expect(duplicate.status).toBe(409);

    await app.request(url, {
      method: "POST",
      headers: json("owner-token"),
      body: JSON.stringify({ name: "other", value: "x" }),
    });
    const lower = await app.request(`${url}/other`, { headers: auth("owner-token") });
    expect(((await lower.json()) as VariableBody).name).toBe("OTHER");

    const rename = await app.request(`${url}/OTHER`, {
      method: "PATCH",
      headers: json("owner-token"),
      body: JSON.stringify({ name: "SEEDED_REPO_VAR" }),
    });
    expect(rename.status).toBe(409);
  });

  it("validates name and value with 422", async () => {
    const url = `${base}/repos/octocat/hello-world/actions/variables`;
    for (const body of [
      { value: "x" },
      { name: "OK" },
      { name: "1BAD", value: "x" },
      { name: "GITHUB_X", value: "x" },
    ]) {
      const response = await app.request(url, {
        method: "POST",
        headers: json("owner-token"),
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(422);
    }
  });

  it("paginates with per_page capped at 30", async () => {
    const url = `${base}/repos/octocat/hello-world/actions/variables`;
    for (let i = 0; i < 34; i++) {
      await app.request(url, {
        method: "POST",
        headers: json("owner-token"),
        body: JSON.stringify({ name: `V_${String(i).padStart(2, "0")}`, value: String(i) }),
      });
    }
    const first = await app.request(`${url}?per_page=100`, { headers: auth("owner-token") });
    const firstBody = (await first.json()) as { total_count: number; variables: VariableBody[] };
    expect(firstBody.total_count).toBe(35);
    expect(firstBody.variables).toHaveLength(30);
    expect(first.headers.get("Link")).toContain('rel="next"');

    const second = await app.request(`${url}?per_page=30&page=2`, { headers: auth("owner-token") });
    expect(((await second.json()) as { variables: VariableBody[] }).variables).toHaveLength(5);

    const defaults = await app.request(url, { headers: auth("owner-token") });
    expect(((await defaults.json()) as { variables: VariableBody[] }).variables).toHaveLength(10);
  });

  it("enforces user access", async () => {
    const url = `${base}/repos/octocat/hello-world/actions/variables`;
    expect((await app.request(url)).status).toBe(401);
    expect((await app.request(url, { headers: auth("outsider-token") })).status).toBe(403);
    expect((await app.request(url, { headers: auth("reader-token") })).status).toBe(200);
    const readerWrite = await app.request(url, {
      method: "POST",
      headers: json("reader-token"),
      body: JSON.stringify({ name: "NOPE", value: "x" }),
    });
    expect(readerWrite.status).toBe(403);
    expect(
      (await app.request(`${base}/repos/octocat/secret-repo/actions/variables`, { headers: auth("outsider-token") }))
        .status,
    ).toBe(404);
  });

  it("checks the actions_variables permission for installation tokens", async () => {
    const url = `${base}/repos/octocat/hello-world/actions/variables`;
    const write = await app.request(url, {
      method: "POST",
      headers: json("inst-repo-write"),
      body: JSON.stringify({ name: "FROM_APP", value: "x" }),
    });
    expect(write.status).toBe(201);

    expect((await app.request(url, { headers: auth("inst-repo-read") })).status).toBe(200);
    const readOnlyWrite = await app.request(`${url}/FROM_APP`, { method: "DELETE", headers: auth("inst-repo-read") });
    expect(readOnlyWrite.status).toBe(403);

    expect((await app.request(url, { headers: auth("inst-repo-none") })).status).toBe(403);
    const noneWrite = await app.request(url, {
      method: "POST",
      headers: json("inst-repo-none"),
      body: JSON.stringify({ name: "NOPE", value: "x" }),
    });
    expect(noneWrite.status).toBe(403);

    expect(
      (await app.request(`${base}/repos/my-org/public-repo/actions/variables`, { headers: auth("inst-repo-write") }))
        .status,
    ).toBe(403);
  });
});

describe("GitHub Actions organization variables", () => {
  let app: Hono;
  let repoId: (fullName: string) => number;

  beforeEach(() => {
    ({ app, repoId } = createTestApp());
  });

  it("creates and reads organization variables with visibility", async () => {
    const url = `${base}/orgs/my-org/actions/variables`;
    const created = await app.request(url, {
      method: "POST",
      headers: json("owner-token"),
      body: JSON.stringify({
        name: "ALLOWLIST",
        value: "a,b",
        visibility: "selected",
        selected_repository_ids: [repoId("my-org/public-repo")],
      }),
    });
    expect(created.status).toBe(201);

    const got = await app.request(`${url}/ALLOWLIST`, { headers: auth("owner-token") });
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual({
      name: "ALLOWLIST",
      value: "a,b",
      visibility: "selected",
      selected_repositories_url: `${base}/orgs/my-org/actions/variables/ALLOWLIST/repositories`,
      created_at: expect.any(String),
      updated_at: expect.any(String),
    });

    const list = await app.request(url, { headers: auth("owner-token") });
    const listed = (await list.json()) as { total_count: number; variables: VariableBody[] };
    expect(listed.total_count).toBe(3);
    expect(listed.variables.map((v) => [v.name, v.visibility])).toEqual([
      ["ALLOWLIST", "selected"],
      ["SEEDED_ALL", "all"],
      ["SEEDED_SELECTED", "selected"],
    ]);
    expect(listed.variables[1].selected_repositories_url).toBeUndefined();

    const duplicate = await app.request(url, {
      method: "POST",
      headers: json("owner-token"),
      body: JSON.stringify({ name: "ALLOWLIST", value: "x", visibility: "all" }),
    });
    expect(duplicate.status).toBe(409);

    const badVisibility = await app.request(url, {
      method: "POST",
      headers: json("owner-token"),
      body: JSON.stringify({ name: "X", value: "x", visibility: "public" }),
    });
    expect(badVisibility.status).toBe(422);

    const missingVisibility = await app.request(url, {
      method: "POST",
      headers: json("owner-token"),
      body: JSON.stringify({ name: "X", value: "x" }),
    });
    expect(missingVisibility.status).toBe(422);
  });

  it("updates, renames, and deletes organization variables", async () => {
    const url = `${base}/orgs/my-org/actions/variables`;
    const patched = await app.request(`${url}/SEEDED_ALL`, {
      method: "PATCH",
      headers: json("owner-token"),
      body: JSON.stringify({ name: "NOW_PRIVATE", value: "changed", visibility: "private" }),
    });
    expect(patched.status).toBe(204);
    const got = await app.request(`${url}/NOW_PRIVATE`, { headers: auth("owner-token") });
    expect(await got.json()).toEqual(expect.objectContaining({ value: "changed", visibility: "private" }));
    expect((await app.request(`${url}/SEEDED_ALL`, { headers: auth("owner-token") })).status).toBe(404);

    const missing = await app.request(`${url}/NOPE`, {
      method: "PATCH",
      headers: json("owner-token"),
      body: JSON.stringify({ value: "x" }),
    });
    expect(missing.status).toBe(404);

    expect((await app.request(`${url}/NOW_PRIVATE`, { method: "DELETE", headers: auth("owner-token") })).status).toBe(
      204,
    );
    expect((await app.request(`${url}/NOW_PRIVATE`, { method: "DELETE", headers: auth("owner-token") })).status).toBe(
      404,
    );
    expect((await app.request(`${base}/orgs/nope/actions/variables`, { headers: auth("owner-token") })).status).toBe(
      404,
    );
  });

  it("manages selected repositories and returns 409 unless visibility is selected", async () => {
    const url = `${base}/orgs/my-org/actions/variables`;
    const orgRepo = repoId("my-org/org-repo");
    const publicRepo = repoId("my-org/public-repo");

    const list = await app.request(`${url}/SEEDED_SELECTED/repositories`, { headers: auth("owner-token") });
    expect(list.status).toBe(200);
    const listed = (await list.json()) as {
      total_count: number;
      repositories: Array<{ id: number; full_name: string }>;
    };
    expect(listed.total_count).toBe(1);
    expect(listed.repositories.map((r) => r.full_name)).toEqual(["my-org/org-repo"]);

    const add = await app.request(`${url}/SEEDED_SELECTED/repositories/${publicRepo}`, {
      method: "PUT",
      headers: auth("owner-token"),
    });
    expect(add.status).toBe(204);
    const afterAdd = await app.request(`${url}/SEEDED_SELECTED/repositories`, { headers: auth("owner-token") });
    expect(((await afterAdd.json()) as { total_count: number }).total_count).toBe(2);

    const remove = await app.request(`${url}/SEEDED_SELECTED/repositories/${orgRepo}`, {
      method: "DELETE",
      headers: auth("owner-token"),
    });
    expect(remove.status).toBe(204);

    const replace = await app.request(`${url}/SEEDED_SELECTED/repositories`, {
      method: "PUT",
      headers: json("owner-token"),
      body: JSON.stringify({ selected_repository_ids: [orgRepo] }),
    });
    expect(replace.status).toBe(204);
    const afterReplace = await app.request(`${url}/SEEDED_SELECTED/repositories`, { headers: auth("owner-token") });
    const replaced = (await afterReplace.json()) as { repositories: Array<{ id: number }> };
    expect(replaced.repositories.map((r) => r.id)).toEqual([orgRepo]);

    const foreign = await app.request(`${url}/SEEDED_SELECTED/repositories`, {
      method: "PUT",
      headers: json("owner-token"),
      body: JSON.stringify({ selected_repository_ids: [repoId("octocat/hello-world")] }),
    });
    expect(foreign.status).toBe(422);

    expect((await app.request(`${url}/SEEDED_ALL/repositories`, { headers: auth("owner-token") })).status).toBe(409);
    const conflictPut = await app.request(`${url}/SEEDED_ALL/repositories`, {
      method: "PUT",
      headers: json("owner-token"),
      body: JSON.stringify({ selected_repository_ids: [orgRepo] }),
    });
    expect(conflictPut.status).toBe(409);
    expect(
      (await app.request(`${url}/SEEDED_ALL/repositories/${orgRepo}`, { method: "PUT", headers: auth("owner-token") }))
        .status,
    ).toBe(409);
    expect(
      (
        await app.request(`${url}/SEEDED_ALL/repositories/${orgRepo}`, {
          method: "DELETE",
          headers: auth("owner-token"),
        })
      ).status,
    ).toBe(409);
    expect((await app.request(`${url}/NOPE/repositories`, { headers: auth("owner-token") })).status).toBe(404);
  });

  it("requires an organization admin or the organization_actions_variables permission", async () => {
    const url = `${base}/orgs/my-org/actions/variables`;
    expect((await app.request(url)).status).toBe(401);
    expect((await app.request(url, { headers: auth("member-token") })).status).toBe(403);
    expect((await app.request(url, { headers: auth("outsider-token") })).status).toBe(403);

    expect((await app.request(url, { headers: auth("inst-org-read") })).status).toBe(200);
    const readOnlyWrite = await app.request(url, {
      method: "POST",
      headers: json("inst-org-read"),
      body: JSON.stringify({ name: "X", value: "x", visibility: "all" }),
    });
    expect(readOnlyWrite.status).toBe(403);
    const write = await app.request(url, {
      method: "POST",
      headers: json("inst-org-write"),
      body: JSON.stringify({ name: "FROM_APP", value: "x", visibility: "all" }),
    });
    expect(write.status).toBe(201);
    expect((await app.request(url, { headers: auth("inst-org-none") })).status).toBe(403);
    expect((await app.request(url, { headers: auth("inst-repo-write") })).status).toBe(403);
  });

  it("lists the organization variables a repository can use", async () => {
    await app.request(`${base}/orgs/my-org/actions/variables`, {
      method: "POST",
      headers: json("owner-token"),
      body: JSON.stringify({ name: "PRIVATE_ONLY", value: "p", visibility: "private" }),
    });

    const orgRepo = await app.request(`${base}/repos/my-org/org-repo/actions/organization-variables`, {
      headers: auth("owner-token"),
    });
    expect(orgRepo.status).toBe(200);
    const orgRepoBody = (await orgRepo.json()) as { total_count: number; variables: VariableBody[] };
    expect(orgRepoBody.variables.map((v) => [v.name, v.value])).toEqual([
      ["PRIVATE_ONLY", "p"],
      ["SEEDED_ALL", "everyone"],
      ["SEEDED_SELECTED", "chosen"],
    ]);
    expect(orgRepoBody.total_count).toBe(3);

    const publicRepo = await app.request(`${base}/repos/my-org/public-repo/actions/organization-variables`, {
      headers: auth("owner-token"),
    });
    const publicBody = (await publicRepo.json()) as { variables: VariableBody[] };
    expect(publicBody.variables.map((v) => v.name)).toEqual(["SEEDED_ALL"]);

    const userRepo = await app.request(`${base}/repos/octocat/hello-world/actions/organization-variables`, {
      headers: auth("owner-token"),
    });
    expect(await userRepo.json()).toEqual({ total_count: 0, variables: [] });

    const outsider = await app.request(`${base}/repos/my-org/org-repo/actions/organization-variables`, {
      headers: auth("outsider-token"),
    });
    expect(outsider.status).toBe(404);
  });
});
