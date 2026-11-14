import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes } from "crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "@emulators/core";
import { Store } from "@emulators/core";
import { WebhookDispatcher } from "@emulators/core";
import { authMiddleware, createApiErrorHandler, createErrorHandler, type TokenMap } from "@emulators/core";
import { getGitHubStore, githubPlugin, seedFromConfig, type GitHubSeedConfig } from "../index.js";

const base = "http://localhost:4000";

const seedConfig: GitHubSeedConfig = {
  users: [{ login: "octocat" }, { login: "org-member" }, { login: "outsider" }],
  orgs: [{ login: "my-org", members: [{ login: "octocat", role: "admin" }, { login: "org-member" }] }],
  repos: [
    { owner: "octocat", name: "hello-world" },
    { owner: "octocat", name: "other-repo" },
    { owner: "octocat", name: "secret-repo", private: true },
  ],
};

interface PublicKeyBody {
  key_id: string;
  key: string;
}

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map([
    ["owner-token", { login: "octocat", id: 1, scopes: ["repo", "admin:org"] }],
    ["member-token", { login: "org-member", id: 2, scopes: ["repo"] }],
    ["outsider-token", { login: "outsider", id: 3, scopes: ["repo"] }],
  ]);

  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  githubPlugin.register(app as any, store, webhooks, base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, seedConfig);

  const gh = getGitHubStore(store);
  const octocat = gh.users.findOneBy("login", "octocat")!;
  const installation = (permissions: Record<string, string>) => ({
    login: "keys-app[bot]",
    id: 900,
    scopes: [],
    installation: {
      installationId: 77,
      appId: 7,
      accountId: octocat.id,
      accountType: "User" as const,
      permissions,
      repositoryIds: [],
      repositorySelection: "all" as const,
    },
  });
  tokenMap.set("inst-secrets", installation({ secrets: "read" }));
  tokenMap.set("inst-none", installation({ issues: "write" }));

  return { app, store };
}

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function getKey(app: Hono, path: string, token = "owner-token"): Promise<PublicKeyBody> {
  const response = await app.request(`${base}${path}`, { headers: auth(token) });
  expect(response.status).toBe(200);
  return (await response.json()) as PublicKeyBody;
}

// A libsodium sealed box is the 32-byte ephemeral public key, then the ciphertext and its 16-byte MAC.
function fakeSealedBox(plaintextLength: number): string {
  return randomBytes(32 + 16 + plaintextLength).toString("base64");
}

describe("GitHub Actions secrets public keys", () => {
  let app: Hono;
  let store: Store;

  beforeEach(() => {
    ({ app, store } = createTestApp());
  });

  it("returns a stable base64 Curve25519 key and key_id per repository and organization", async () => {
    const repoKey = await getKey(app, "/repos/octocat/hello-world/actions/secrets/public-key");
    expect(Object.keys(repoKey).sort()).toEqual(["key", "key_id"]);
    expect(repoKey.key_id).toMatch(/^\d+$/);
    expect(Buffer.from(repoKey.key, "base64")).toHaveLength(32);
    expect(Buffer.from(repoKey.key, "base64").toString("base64")).toBe(repoKey.key);

    expect(await getKey(app, "/repos/octocat/hello-world/actions/secrets/public-key")).toEqual(repoKey);

    const otherRepoKey = await getKey(app, "/repos/octocat/other-repo/actions/secrets/public-key");
    expect(otherRepoKey.key).not.toBe(repoKey.key);
    expect(otherRepoKey.key_id).not.toBe(repoKey.key_id);

    const orgKey = await getKey(app, "/orgs/my-org/actions/secrets/public-key");
    expect(Buffer.from(orgKey.key, "base64")).toHaveLength(32);
    expect(orgKey.key).not.toBe(repoKey.key);
    expect(await getKey(app, "/orgs/my-org/actions/secrets/public-key")).toEqual(orgKey);
  });

  it("serves a key that a client can use for X25519 key agreement with the retained private key", async () => {
    const repoKey = await getKey(app, "/repos/octocat/hello-world/actions/secrets/public-key");
    const recipient = createPublicKey({
      key: { kty: "OKP", crv: "X25519", x: Buffer.from(repoKey.key, "base64").toString("base64url") },
      format: "jwk",
    });
    const ephemeral = generateKeyPairSync("x25519");
    const clientShared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });

    const gh = getGitHubStore(store);
    const stored = gh.actionsPublicKeys.all().find((k) => k.key_id === repoKey.key_id)!;
    const serverPrivate = createPrivateKey({
      key: Buffer.from(stored.private_key, "base64"),
      format: "der",
      type: "pkcs8",
    });
    const serverShared = diffieHellman({ privateKey: serverPrivate, publicKey: ephemeral.publicKey });
    expect(serverShared.equals(clientShared)).toBe(true);
  });

  it("matches public-key before the secret name route", async () => {
    const put = await app.request(`${base}/repos/octocat/hello-world/actions/secrets/MY_SECRET`, {
      method: "PUT",
      headers: { ...auth("owner-token"), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(put.status).toBe(201);

    const key = await getKey(app, "/repos/octocat/hello-world/actions/secrets/public-key");
    expect(key.key_id).toBeTruthy();
    const secret = await app.request(`${base}/repos/octocat/hello-world/actions/secrets/MY_SECRET`, {
      headers: auth("owner-token"),
    });
    expect(secret.status).toBe(200);
    expect(((await secret.json()) as { name: string }).name).toBe("MY_SECRET");
  });

  it("returns 404 for missing or hidden owners and enforces access", async () => {
    const missingRepo = await app.request(`${base}/repos/octocat/missing/actions/secrets/public-key`, {
      headers: auth("owner-token"),
    });
    expect(missingRepo.status).toBe(404);
    const missingOrg = await app.request(`${base}/orgs/missing/actions/secrets/public-key`, {
      headers: auth("owner-token"),
    });
    expect(missingOrg.status).toBe(404);

    const hidden = await app.request(`${base}/repos/octocat/secret-repo/actions/secrets/public-key`, {
      headers: auth("outsider-token"),
    });
    expect(hidden.status).toBe(404);
    await getKey(app, "/repos/octocat/secret-repo/actions/secrets/public-key");

    expect((await app.request(`${base}/orgs/my-org/actions/secrets/public-key`)).status).toBe(401);
    const member = await app.request(`${base}/orgs/my-org/actions/secrets/public-key`, {
      headers: auth("member-token"),
    });
    expect(member.status).toBe(403);
  });

  it("checks the secrets permission for installation tokens on private repositories", async () => {
    await getKey(app, "/repos/octocat/secret-repo/actions/secrets/public-key", "inst-secrets");
    const denied = await app.request(`${base}/repos/octocat/secret-repo/actions/secrets/public-key`, {
      headers: auth("inst-none"),
    });
    expect(denied.status).toBe(403);
  });

  it("validates key_id and encrypted_value on repository secret writes", async () => {
    const key = await getKey(app, "/repos/octocat/hello-world/actions/secrets/public-key");
    const url = `${base}/repos/octocat/hello-world/actions/secrets/MY_SECRET`;
    const put = (body: unknown) =>
      app.request(url, {
        method: "PUT",
        headers: { ...auth("owner-token"), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    expect((await put({ encrypted_value: fakeSealedBox(5), key_id: key.key_id })).status).toBe(201);
    expect((await put({ encrypted_value: fakeSealedBox(7), key_id: key.key_id })).status).toBe(204);

    expect((await put({ encrypted_value: fakeSealedBox(5), key_id: "0123" })).status).toBe(422);
    expect((await put({ encrypted_value: "c2VhbGVk", key_id: key.key_id })).status).toBe(422);
    expect((await put({ encrypted_value: "not base64!", key_id: key.key_id })).status).toBe(422);
    expect((await put({ encrypted_value: fakeSealedBox(5) })).status).toBe(422);

    const otherRepoKey = await getKey(app, "/repos/octocat/other-repo/actions/secrets/public-key");
    expect((await put({ encrypted_value: fakeSealedBox(5), key_id: otherRepoKey.key_id })).status).toBe(422);
  });

  it("validates key_id and encrypted_value on organization secret writes", async () => {
    const orgKey = await getKey(app, "/orgs/my-org/actions/secrets/public-key");
    const repoKey = await getKey(app, "/repos/octocat/hello-world/actions/secrets/public-key");
    const url = `${base}/orgs/my-org/actions/secrets/ORG_SECRET`;
    const put = (body: unknown) =>
      app.request(url, {
        method: "PUT",
        headers: { ...auth("owner-token"), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    expect((await put({ encrypted_value: fakeSealedBox(3), key_id: repoKey.key_id, visibility: "all" })).status).toBe(
      422,
    );
    expect((await put({ encrypted_value: fakeSealedBox(3), key_id: orgKey.key_id, visibility: "all" })).status).toBe(
      201,
    );
  });
});
