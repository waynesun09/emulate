import { buildSchema, graphql, type GraphQLError } from "graphql";
import type { AppEnv, AuthUser, Context, RouteContext } from "@emulators/core";
import { ApiError } from "@emulators/core";
import { getGitHubStore } from "../store.js";
import type { GitHubStore } from "../store.js";
import type { GitHubRepo } from "../entities.js";
import { formatRepo, formatUser, lookupRepo } from "../helpers.js";
import { findOrCreateBlob, flattenTree, resolveBranchToCommit } from "../git-helpers.js";
import {
  assertBranchUpdateAllowed,
  assertRepoContentsWrite,
  assertRepoPermission,
  getActorUser,
  ownerLoginOf,
} from "../route-helpers.js";
import { commitFiles, decodeBodyContent, isWorkflowPath, normalizePath, type FileTreeEntry } from "./contents.js";

// Only the parts of GitHub's public schema that the emulator implements. Names and nullability follow
// https://docs.github.com/en/graphql/reference/mutations#createcommitonbranch
const schema = buildSchema(`
  scalar Base64String
  scalar DateTime
  scalar GitObjectID
  scalar URI

  type Query {
    viewer: User!
  }

  type Mutation {
    createCommitOnBranch(input: CreateCommitOnBranchInput!): CreateCommitOnBranchPayload
  }

  type User {
    login: String!
  }

  input CreateCommitOnBranchInput {
    branch: CommittableBranch!
    clientMutationId: String
    expectedHeadOid: GitObjectID!
    fileChanges: FileChanges
    message: CommitMessage!
  }

  input CommittableBranch {
    branchName: String
    id: ID
    repositoryNameWithOwner: String
  }

  input CommitMessage {
    body: String
    headline: String!
  }

  input FileChanges {
    additions: [FileAddition!] = []
    deletions: [FileDeletion!] = []
  }

  input FileAddition {
    contents: Base64String!
    path: String!
  }

  input FileDeletion {
    path: String!
  }

  type CreateCommitOnBranchPayload {
    clientMutationId: String
    commit: Commit
    ref: Ref
  }

  type Commit {
    abbreviatedOid: String!
    committedDate: DateTime!
    message: String!
    messageBody: String!
    messageHeadline: String!
    oid: GitObjectID!
    url: URI!
  }

  type Ref {
    id: ID!
    name: String!
    prefix: String!
  }
`);

type ErrorType = "NOT_FOUND" | "FORBIDDEN" | "UNPROCESSABLE" | "STALE_DATA" | "BRANCH_PROTECTION_RULE_VIOLATION";

class TypedGraphQLError extends Error {
  constructor(
    public type: ErrorType,
    message: string,
  ) {
    super(message);
    this.name = "TypedGraphQLError";
  }
}

interface CreateCommitOnBranchArgs {
  input: {
    branch: { branchName?: string | null; id?: string | null; repositoryNameWithOwner?: string | null };
    clientMutationId?: string | null;
    expectedHeadOid: string;
    fileChanges?: {
      additions?: Array<{ contents: string; path: string }> | null;
      deletions?: Array<{ path: string }> | null;
    } | null;
    message: { body?: string | null; headline: string };
  };
}

interface GraphQLContext {
  authUser: AuthUser | undefined;
}

function resolveBranch(
  gh: GitHubStore,
  branch: CreateCommitOnBranchArgs["input"]["branch"],
): { repo: GitHubRepo; branchName: string } {
  if (branch.id) {
    const ref = gh.refs.all().find((candidate) => candidate.node_id === branch.id);
    const repo = ref ? gh.repos.get(ref.repo_id) : undefined;
    if (!ref || !repo || !ref.ref.startsWith("refs/heads/")) {
      throw new TypedGraphQLError("NOT_FOUND", `Could not resolve to a node with the global id of '${branch.id}'`);
    }
    return { repo, branchName: ref.ref.slice("refs/heads/".length) };
  }

  if (!branch.repositoryNameWithOwner || !branch.branchName) {
    throw new TypedGraphQLError(
      "UNPROCESSABLE",
      "Either branch.id or both branch.repositoryNameWithOwner and branch.branchName must be provided",
    );
  }
  const [owner, name, ...rest] = branch.repositoryNameWithOwner.split("/");
  const repo = owner && name && rest.length === 0 ? lookupRepo(gh, owner, name) : undefined;
  if (!repo) {
    throw new TypedGraphQLError(
      "NOT_FOUND",
      `Could not resolve to a Repository with the name '${branch.repositoryNameWithOwner}'.`,
    );
  }
  return { repo, branchName: branch.branchName.replace(/^refs\/heads\//, "") };
}

function errorTypeForStatus(status: number): ErrorType {
  if (status === 404) return "NOT_FOUND";
  if (status === 401 || status === 403) return "FORBIDDEN";
  if (status === 409) return "BRANCH_PROTECTION_RULE_VIOLATION";
  return "UNPROCESSABLE";
}

function formatError(error: GraphQLError) {
  const original = error.originalError;
  let type: ErrorType | undefined;
  let message = error.message;
  if (original instanceof TypedGraphQLError) {
    type = original.type;
  } else if (original instanceof ApiError) {
    type = errorTypeForStatus(original.status);
    if (type === "NOT_FOUND") message = "Could not resolve to a Repository or branch with the given name.";
  }
  return {
    ...(type ? { type } : {}),
    ...(error.path ? { path: error.path } : {}),
    ...(error.locations ? { locations: error.locations } : {}),
    message,
  };
}

export function graphqlRoutes({ app, store, webhooks, baseUrl }: RouteContext): void {
  const gh = getGitHubStore(store);

  const root = {
    viewer: (_args: unknown, context: GraphQLContext) => {
      const user = context.authUser ? getActorUser(gh, context.authUser) : undefined;
      return { login: user?.login ?? context.authUser?.login };
    },

    createCommitOnBranch: ({ input }: CreateCommitOnBranchArgs, context: GraphQLContext) => {
      const { repo, branchName } = resolveBranch(gh, input.branch);
      const user = assertRepoContentsWrite(gh, context.authUser, repo);

      const additions = input.fileChanges?.additions ?? [];
      const deletions = input.fileChanges?.deletions ?? [];
      const addedPaths = additions.map((addition) => normalizePath(addition.path));
      const deletedPaths = deletions.map((deletion) => normalizePath(deletion.path));
      if ([...addedPaths, ...deletedPaths].some(isWorkflowPath)) {
        assertRepoPermission(gh, context.authUser, repo, "workflows", "write");
      }

      const headCommit = resolveBranchToCommit(gh, repo, branchName);
      if (!headCommit) {
        throw new TypedGraphQLError(
          "NOT_FOUND",
          `Could not resolve to a Ref with the name 'refs/heads/${branchName}' in '${repo.full_name}'.`,
        );
      }
      if (headCommit.sha !== input.expectedHeadOid) {
        throw new TypedGraphQLError(
          "STALE_DATA",
          `Expected branch to point to "${input.expectedHeadOid}" but it did not. ` +
            `A ref named "refs/heads/${branchName}" is at ${headCommit.sha} but expected ${input.expectedHeadOid}.`,
        );
      }
      assertBranchUpdateAllowed(gh, user, repo, branchName, { parentCount: 1, signed: true });

      const existing = flattenTree(gh, repo.id, headCommit.tree_sha).blobs;
      const changes = new Map<string, FileTreeEntry | null>();
      for (const path of deletedPaths) changes.set(path, null);
      additions.forEach((addition, index) => {
        let decoded: ReturnType<typeof decodeBodyContent>;
        try {
          decoded = decodeBodyContent(addition.contents);
        } catch {
          throw new TypedGraphQLError("UNPROCESSABLE", `contents of ${addedPaths[index]} is not valid Base64`);
        }
        const bytes = decoded.text !== null ? Buffer.from(decoded.text, "utf8") : Buffer.from(decoded.base64, "base64");
        const blob = findOrCreateBlob(gh, repo.id, bytes);
        const previous = existing.get(addedPaths[index]);
        changes.set(addedPaths[index], {
          mode: previous?.type === "blob" ? previous.mode : "100644",
          type: "blob",
          sha: blob.sha,
          size: blob.size,
        });
      });

      const headline = input.message.headline;
      const message = input.message.body ? `${headline}\n\n${input.message.body}` : headline;
      const commit = commitFiles(gh, {
        repo,
        branchName,
        message,
        actor: user,
        author: {
          name: user.name ?? user.login,
          email: user.email ?? `${user.login}@users.noreply.github.com`,
        },
        committer: { name: "GitHub", email: "noreply@github.com" },
        changes,
        headCommit,
      });

      const added: string[] = [];
      const modified: string[] = [];
      const removed: string[] = [];
      for (const [path, change] of changes) {
        if (change === null) {
          if (existing.has(path)) removed.push(path);
        } else if (existing.has(path)) {
          modified.push(path);
        } else {
          added.push(path);
        }
      }

      webhooks.dispatch(
        "push",
        undefined,
        {
          ref: `refs/heads/${branchName}`,
          before: headCommit.sha,
          after: commit.sha,
          repository: formatRepo(gh.repos.get(repo.id)!, gh, baseUrl),
          sender: formatUser(user, baseUrl),
          commits: [
            {
              id: commit.sha,
              message: commit.message,
              timestamp: commit.committer_date,
              author: { name: commit.author_name, email: commit.author_email },
              added,
              removed,
              modified,
            },
          ],
        },
        ownerLoginOf(gh, repo),
        repo.name,
      );

      const ref = gh.refs.findBy("repo_id", repo.id).find((candidate) => candidate.ref === `refs/heads/${branchName}`);
      const [messageHeadline, ...bodyLines] = commit.message.split("\n");
      return {
        clientMutationId: input.clientMutationId ?? null,
        commit: {
          abbreviatedOid: commit.sha.slice(0, 7),
          committedDate: commit.committer_date,
          message: commit.message,
          messageBody: bodyLines.join("\n").replace(/^\n+/, ""),
          messageHeadline,
          oid: commit.sha,
          url: `${baseUrl}/${repo.full_name}/commit/${commit.sha}`,
        },
        ref: { id: ref?.node_id ?? "", name: branchName, prefix: "refs/heads/" },
      };
    },
  };

  const handle = async (c: Context<AppEnv>) => {
    const authUser = c.get("authUser");
    if (!authUser) {
      return c.json(
        {
          message: "This endpoint requires you to be authenticated.",
          documentation_url:
            "https://docs.github.com/graphql/guides/forming-calls-with-graphql#authenticating-with-graphql",
        },
        401,
      );
    }

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof body.query !== "string" || !body.query) {
      return c.json({ errors: [{ message: "A query attribute must be specified and must be a string." }] });
    }
    const variables =
      body.variables && typeof body.variables === "object" && !Array.isArray(body.variables)
        ? (body.variables as Record<string, unknown>)
        : undefined;

    const result = await graphql({
      schema,
      source: body.query,
      rootValue: root,
      contextValue: { authUser } satisfies GraphQLContext,
      variableValues: variables,
      operationName: typeof body.operationName === "string" ? body.operationName : undefined,
    });

    return c.json({
      ...(result.data !== undefined ? { data: result.data } : {}),
      ...(result.errors ? { errors: result.errors.map(formatError) } : {}),
    });
  };

  app.post("/graphql", handle);
  app.post("/api/graphql", handle);
}
