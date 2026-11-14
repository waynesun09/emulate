import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { describe, it, expect, vi } from "vitest";
import { Hono, Store, WebhookDispatcher } from "@emulators/core";
import { authMiddleware, createApiErrorHandler, createErrorHandler, type TokenMap } from "@emulators/core";
import { githubPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";

const MUTATION = `mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    clientMutationId
    commit { oid url message messageHeadline messageBody committedDate }
    ref { name prefix }
  }
}`;

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("test-token", { login: "octocat", id: 1, scopes: ["repo", "user"] });
  tokenMap.set("outsider-token", { login: "outsider", id: 2, scopes: ["repo"] });

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  githubPlugin.register(app as any, store, webhooks, base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "octocat" }, { login: "outsider" }],
    repos: [{ owner: "octocat", name: "hello-world" }],
  });
  return { app, webhooks };
}

function gitObjectSha(type: "blob" | "tree" | "commit", content: Buffer): string {
  return createHash("sha1")
    .update(Buffer.from(`${type} ${content.byteLength}\0`, "utf8"))
    .update(content)
    .digest("hex");
}

function gitIdentityDate(date: string): string {
  return `${Math.floor(Date.parse(date) / 1000)} +0000`;
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

async function headSha(app: Hono, branch = "main"): Promise<string> {
  const res = await app.request(`${base}/repos/octocat/hello-world/git/ref/heads/${branch}`, {
    headers: { Authorization: "Bearer test-token" },
  });
  return ((await res.json()) as { object: { sha: string } }).object.sha;
}

async function gql(
  app: Hono,
  input: Record<string, unknown>,
  { authorization = "bearer test-token", path = "/graphql" } = {},
) {
  const res = await app.request(`${base}${path}`, {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: JSON.stringify({ query: MUTATION, variables: { input } }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe("GraphQL createCommitOnBranch", () => {
  it("commits additions and deletions on top of the branch head", async () => {
    const { app, webhooks } = createTestApp();
    const dispatch = vi.spyOn(webhooks, "dispatch");
    const before = await headSha(app);

    const { status, body } = await gql(app, {
      branch: { repositoryNameWithOwner: "octocat/hello-world", branchName: "main" },
      expectedHeadOid: before,
      message: { headline: "Add files", body: "Remove the README." },
      fileChanges: {
        additions: [
          { path: "a.txt", contents: b64("hello\n") },
          { path: "docs/guide.md", contents: b64("# Guide\n") },
        ],
        deletions: [{ path: "README.md" }],
      },
    });

    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    const payload = body.data.createCommitOnBranch;
    const oid = payload.commit.oid as string;
    expect(oid).toMatch(/^[0-9a-f]{40}$/);
    expect(payload.commit.url).toBe(`${base}/octocat/hello-world/commit/${oid}`);
    expect(payload.commit.message).toBe("Add files\n\nRemove the README.");
    expect(payload.commit.messageHeadline).toBe("Add files");
    expect(payload.commit.messageBody).toBe("Remove the README.");
    expect(payload.ref).toEqual({ name: "main", prefix: "refs/heads/" });
    expect(await headSha(app)).toBe(oid);

    const commitRes = await app.request(`${base}/repos/octocat/hello-world/git/commits/${oid}`, {
      headers: { Authorization: "Bearer test-token" },
    });
    const commit = (await commitRes.json()) as any;
    expect(commit.parents.map((parent: { sha: string }) => parent.sha)).toEqual([before]);
    expect(commit.author.name).toBe("octocat");
    expect(commit.committer).toMatchObject({ name: "GitHub", email: "noreply@github.com" });
    const headers = [
      `tree ${commit.tree.sha}`,
      `parent ${before}`,
      `author ${commit.author.name} <${commit.author.email}> ${gitIdentityDate(commit.author.date)}`,
      `committer ${commit.committer.name} <${commit.committer.email}> ${gitIdentityDate(commit.committer.date)}`,
    ];
    expect(oid).toBe(gitObjectSha("commit", Buffer.from(`${headers.join("\n")}\n\n${commit.message}\n`, "utf8")));

    const file = await app.request(`${base}/repos/octocat/hello-world/contents/a.txt`, {
      headers: { Authorization: "Bearer test-token" },
    });
    const fileBody = (await file.json()) as { content: string; sha: string };
    expect(Buffer.from(fileBody.content, "base64").toString("utf8")).toBe("hello\n");
    expect(fileBody.sha).toBe(gitObjectSha("blob", Buffer.from("hello\n")));
    const readme = await app.request(`${base}/repos/octocat/hello-world/contents/README.md`, {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(readme.status).toBe(404);

    const commits = await app.request(`${base}/repos/octocat/hello-world/commits?sha=main`, {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(((await commits.json()) as Array<{ sha: string }>)[0].sha).toBe(oid);

    const push = dispatch.mock.calls.find(([event]) => event === "push");
    expect(push?.[2]).toMatchObject({
      ref: "refs/heads/main",
      before,
      after: oid,
      commits: [{ id: oid, added: ["a.txt", "docs/guide.md"], removed: ["README.md"], modified: [] }],
    });
  });

  it.skipIf(!hasGit())("produces a tree that git write-tree reproduces", async () => {
    const { app } = createTestApp();
    const { body } = await gql(app, {
      branch: { repositoryNameWithOwner: "octocat/hello-world", branchName: "main" },
      expectedHeadOid: await headSha(app),
      message: { headline: "Nested files" },
      fileChanges: {
        additions: [
          { path: "src/index.ts", contents: b64("export {};\n") },
          { path: "src/lib/util.ts", contents: b64("export const x = 1;\n") },
        ],
      },
    });
    const oid = body.data.createCommitOnBranch.commit.oid as string;
    const auth = { headers: { Authorization: "Bearer test-token" } };
    const commit = (await (await app.request(`${base}/repos/octocat/hello-world/git/commits/${oid}`, auth)).json()) as {
      tree: { sha: string };
    };
    const tree = (await (
      await app.request(`${base}/repos/octocat/hello-world/git/trees/${commit.tree.sha}?recursive=1`, auth)
    ).json()) as { tree: Array<{ path: string; type: string; sha: string }> };

    const dir = mkdtempSync(join(tmpdir(), "emulate-graphql-"));
    try {
      execFileSync("git", ["init", "-q", dir]);
      for (const entry of tree.tree.filter((candidate) => candidate.type === "blob")) {
        const blob = (await (
          await app.request(`${base}/repos/octocat/hello-world/git/blobs/${entry.sha}`, auth)
        ).json()) as { content: string };
        mkdirSync(dirname(join(dir, entry.path)), { recursive: true });
        writeFileSync(join(dir, entry.path), Buffer.from(blob.content, "base64"));
      }
      execFileSync("git", ["-C", dir, "add", "-A"]);
      const written = execFileSync("git", ["-C", dir, "write-tree"], { encoding: "utf8" }).trim();
      expect(written).toBe(commit.tree.sha);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts the token scheme, the branch node id, and the /api/graphql path", async () => {
    const { app } = createTestApp();
    const refRes = await app.request(`${base}/repos/octocat/hello-world/git/ref/heads/main`, {
      headers: { Authorization: "token test-token" },
    });
    const ref = (await refRes.json()) as { node_id: string; object: { sha: string } };
    expect(ref.node_id).toBeTruthy();

    const { status, body } = await gql(
      app,
      {
        branch: { id: ref.node_id },
        expectedHeadOid: ref.object.sha,
        message: { headline: "Empty commit" },
        clientMutationId: "client-1",
      },
      { authorization: "token test-token", path: "/api/graphql" },
    );
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(body.data.createCommitOnBranch.clientMutationId).toBe("client-1");
    expect(await headSha(app)).toBe(body.data.createCommitOnBranch.commit.oid);
  });

  it("returns STALE_DATA when expectedHeadOid is not the branch head", async () => {
    const { app } = createTestApp();
    const head = await headSha(app);
    const stale = "0".repeat(40);
    const { status, body } = await gql(app, {
      branch: { repositoryNameWithOwner: "octocat/hello-world", branchName: "main" },
      expectedHeadOid: stale,
      message: { headline: "Stale" },
      fileChanges: { additions: [{ path: "a.txt", contents: b64("a") }] },
    });
    expect(status).toBe(200);
    expect(body.data.createCommitOnBranch).toBeNull();
    expect(body.errors[0].type).toBe("STALE_DATA");
    expect(body.errors[0].path).toEqual(["createCommitOnBranch"]);
    expect(body.errors[0].message).toContain(`is at ${head} but expected ${stale}`);
    expect(await headSha(app)).toBe(head);
  });

  it("returns NOT_FOUND for a missing branch or repository", async () => {
    const { app } = createTestApp();
    const head = await headSha(app);
    const missingBranch = await gql(app, {
      branch: { repositoryNameWithOwner: "octocat/hello-world", branchName: "nope" },
      expectedHeadOid: head,
      message: { headline: "Missing" },
    });
    expect(missingBranch.status).toBe(200);
    expect(missingBranch.body.errors[0].type).toBe("NOT_FOUND");

    const missingRepo = await gql(app, {
      branch: { repositoryNameWithOwner: "octocat/nope", branchName: "main" },
      expectedHeadOid: head,
      message: { headline: "Missing" },
    });
    expect(missingRepo.body.errors[0].type).toBe("NOT_FOUND");
  });

  it("returns FORBIDDEN when the token cannot write to the repository", async () => {
    const { app } = createTestApp();
    const head = await headSha(app);
    const { status, body } = await gql(
      app,
      {
        branch: { repositoryNameWithOwner: "octocat/hello-world", branchName: "main" },
        expectedHeadOid: head,
        message: { headline: "Not mine" },
        fileChanges: { additions: [{ path: "a.txt", contents: b64("a") }] },
      },
      { authorization: "bearer outsider-token" },
    );
    expect(status).toBe(200);
    expect(body.errors[0].type).toBe("FORBIDDEN");
    expect(await headSha(app)).toBe(head);
  });

  it("rejects contents that are not valid Base64", async () => {
    const { app } = createTestApp();
    const head = await headSha(app);
    const { status, body } = await gql(app, {
      branch: { repositoryNameWithOwner: "octocat/hello-world", branchName: "main" },
      expectedHeadOid: head,
      message: { headline: "Bad" },
      fileChanges: { additions: [{ path: "a.txt", contents: "not base64!" }] },
    });
    expect(status).toBe(200);
    expect(body.errors[0].type).toBe("UNPROCESSABLE");
    expect(await headSha(app)).toBe(head);
  });

  it("satisfies required signatures but not other branch protection rules", async () => {
    const { app } = createTestApp();
    const protect = (rules: Record<string, unknown>) =>
      app.request(`${base}/repos/octocat/hello-world/branches/main/protection`, {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({
          required_status_checks: null,
          enforce_admins: true,
          required_pull_request_reviews: null,
          restrictions: null,
          ...rules,
        }),
      });

    expect((await protect({ required_signatures: true })).status).toBe(200);
    const signed = await gql(app, {
      branch: { repositoryNameWithOwner: "octocat/hello-world", branchName: "main" },
      expectedHeadOid: await headSha(app),
      message: { headline: "Signed" },
    });
    expect(signed.body.errors).toBeUndefined();

    expect((await protect({ required_pull_request_reviews: { required_approving_review_count: 1 } })).status).toBe(200);
    const blocked = await gql(app, {
      branch: { repositoryNameWithOwner: "octocat/hello-world", branchName: "main" },
      expectedHeadOid: await headSha(app),
      message: { headline: "Blocked" },
    });
    expect(blocked.body.errors[0].type).toBe("BRANCH_PROTECTION_RULE_VIOLATION");
  });

  it("requires authentication and answers viewer queries", async () => {
    const { app } = createTestApp();
    const anonymous = await app.request(`${base}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ viewer { login } }" }),
    });
    expect(anonymous.status).toBe(401);

    const viewer = await app.request(`${base}/graphql`, {
      method: "POST",
      headers: { Authorization: "bearer test-token", "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ viewer { login } }" }),
    });
    expect(await viewer.json()).toEqual({ data: { viewer: { login: "octocat" } } });
  });
});

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
