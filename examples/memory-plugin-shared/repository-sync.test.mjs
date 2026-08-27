import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createRepositoryArchive,
  createWikiArchive,
  isSuccessfulGitMutation,
  prepareRepositoryUploadInputs,
  resolveRepositoryContext,
  syncRepositoryFromHook,
} from "./lib/repository-sync.mjs";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function createRepository() {
  const root = mkdtempSync(join(tmpdir(), "openviking-repository-sync-"));
  git(root, "init");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "OpenViking Test");
  writeFileSync(join(root, ".gitignore"), "*.log\n");
  writeFileSync(join(root, "README.md"), "# repository\n");
  writeFileSync(join(root, "ignored.log"), "ignored\n");
  git(root, "add", ".gitignore", "README.md");
  git(root, "commit", "-m", "initial");
  return root;
}

function writeWiki(root, commit = git(root, "rev-parse", "HEAD")) {
  const wiki = join(root, ".repo_memory");
  mkdirSync(join(wiki, "resources"), { recursive: true });
  mkdirSync(join(wiki, "raw"), { recursive: true });
  writeFileSync(join(wiki, "PROFILE.md"), [
    "---",
    'schema: "repo_memory_profile.v0.2"',
    `local_head: "${commit}"`,
    `source_tree: "${git(root, "write-tree")}"`,
    'build_mode: "lightweight"',
    "---",
    "# Repository Wiki",
    "[Architecture](architecture.md)",
    "",
  ].join("\n"));
  writeFileSync(join(wiki, "architecture.md"), [
    "---",
    'schema: "repo_memory_wiki_page.v0.1"',
    "---",
    "# Architecture",
    `Local root: ${root}`,
    "",
  ].join("\n"));
  writeFileSync(join(wiki, "resources", "commits.md"), "# Commits\n");
  writeFileSync(join(wiki, "resources", "prs.md"), "# PRs\n");
  writeFileSync(join(wiki, "resources", "issues.md"), "# Issues\n");
  writeFileSync(join(wiki, "raw", "git-commits.json"), "{}\n");
  writeFileSync(join(wiki, "_plan.md"), "temporary\n");
  return wiki;
}

test("isSuccessfulGitMutation accepts successful writes and rejects reads or failures", () => {
  assert.equal(isSuccessfulGitMutation({
    tool_name: "Bash",
    tool_input: { command: "git commit -m test" },
    tool_response: { exit_code: 0 },
  }), true);
  assert.equal(isSuccessfulGitMutation({
    tool_name: "RunCommand",
    tool_input: { command: "git status" },
    tool_response: { exit_code: 0 },
  }), false);
  assert.equal(isSuccessfulGitMutation({
    tool_name: "Shell",
    tool_input: { command: "git pull --rebase" },
    tool_response: { exit_code: 1 },
  }), false);
  assert.equal(isSuccessfulGitMutation({
    tool_name: "Read",
    tool_input: { command: "git commit -m test" },
  }), false);
  assert.equal(isSuccessfulGitMutation({
    tool_name: "exec_command",
    tool_input: { cmd: "git commit -m test" },
    tool_response: { exit_code: 0 },
  }), true);
  assert.equal(isSuccessfulGitMutation({
    tool_name: "codex_exec",
    tool_input: { cmd: "git commit -m test" },
    tool_response: { exit_code: 0 },
  }), true);
  assert.equal(isSuccessfulGitMutation({
    tool_name: "Bash",
    tool_input: { command: "git commit -m test && echo done" },
    tool_response: { exit_code: 0 },
  }), true);
  assert.equal(isSuccessfulGitMutation({
    tool_name: "Bash",
    tool_input: { command: 'echo "git commit -m test"' },
    tool_response: { exit_code: 0 },
  }), false);
});

test("prepareRepositoryUploadInputs preserves Wiki provenance from a pre-commit build", async () => {
  const root = createRepository();
  try {
    writeFileSync(join(root, "README.md"), "# updated repository\n");
    git(root, "add", "README.md");
    const previousCommit = git(root, "rev-parse", "HEAD");
    writeWiki(root, previousCommit);
    git(root, "commit", "-m", "update repository");
    const context = await resolveRepositoryContext(root);
    const prepared = await prepareRepositoryUploadInputs(
      context,
      { baseUrl: "http://127.0.0.1:1933", user: "alice" },
      { wikiUploadEnabled: true },
    );
    assert.equal(prepared.wiki.status, "ready");
    assert.equal(prepared.wiki.localHead, previousCommit);
    assert.equal(prepared.wiki.sourceCommit, previousCommit);
    assert.equal(prepared.wiki.sourceTree, context.tree);
    assert.equal(prepared.wiki.triggerCommit, context.commit);
    assert.equal(prepared.wiki.triggerTree, context.tree);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createRepositoryArchive contains HEAD files only", async () => {
  const root = createRepository();
  try {
    const context = await resolveRepositoryContext(root);
    const bundle = await createRepositoryArchive(context);
    try {
      const listing = execFileSync("unzip", ["-Z1", bundle.archive], { encoding: "utf8" })
        .trim().split("\n");
      assert.ok(listing.includes("README.md"));
      assert.ok(listing.includes(".gitignore"));
      assert.equal(listing.includes("ignored.log"), false);
      assert.equal(listing.some((name) => name.startsWith(".git/")), false);
      assert.equal(context.commit, git(root, "rev-parse", "HEAD"));
    } finally {
      await bundle.cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createRepositoryArchive excludes a tracked repository Wiki", async () => {
  const root = createRepository();
  try {
    mkdirSync(join(root, ".repo_memory"), { recursive: true });
    writeFileSync(join(root, ".repo_memory", "PROFILE.md"), "tracked Wiki\n");
    git(root, "add", "-f", ".repo_memory/PROFILE.md");
    git(root, "commit", "-m", "track Wiki by mistake");
    const context = await resolveRepositoryContext(root);
    const bundle = await createRepositoryArchive(context);
    try {
      const listing = execFileSync("unzip", ["-Z1", bundle.archive], { encoding: "utf8" });
      assert.doesNotMatch(listing, /\.repo_memory/u);
      assert.match(listing, /README\.md/u);
    } finally {
      await bundle.cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveRepositoryContext keeps sanitized branch targets collision-safe", async () => {
  const root = createRepository();
  try {
    git(root, "checkout", "-b", "feature/local");
    const slashBranch = await resolveRepositoryContext(root);
    git(root, "checkout", "-b", "feature-local");
    const dashBranch = await resolveRepositoryContext(root);

    assert.notEqual(slashBranch.targetUri, dashBranch.targetUri);
    assert.match(slashBranch.targetUri, /\/feature-local-[0-9a-f]{8}$/u);
    assert.match(dashBranch.targetUri, /\/feature-local$/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("syncRepositoryFromHook uploads once and submits args.git_local", async () => {
  const root = createRepository();
  const stateDir = mkdtempSync(join(tmpdir(), "openviking-repository-state-"));
  const originalFetch = globalThis.fetch;
  process.env.OPENVIKING_REPOSITORY_SYNC_STATE_DIR = stateDir;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/resources/temp_upload")) {
      assert.ok(init.body instanceof FormData);
      return new Response(JSON.stringify({
        status: "ok",
        result: { temp_file_id: "upload_repo.zip" },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const body = JSON.parse(init.body);
    assert.equal(body.temp_file_id, "upload_repo.zip");
    assert.equal(body.wait, false);
    assert.equal(body.args.git_local.repo_name, root.split("/").pop());
    assert.equal(body.args.git_local.commit, git(root, "rev-parse", "HEAD"));
    assert.equal(body.args.git_local.archive_format, "zip");
    return new Response(JSON.stringify({
      status: "ok",
      result: { status: "success", task_id: "task-1", root_uri: body.to },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const input = {
    tool_name: "Bash",
    tool_input: { command: "git commit -m initial" },
    tool_response: { exit_code: 0 },
    cwd: root,
  };
  const credentials = {
    baseUrl: "http://127.0.0.1:1933",
    apiKey: "test-key",
    account: "account",
    user: "user",
    peerId: "",
  };

  try {
    const first = await syncRepositoryFromHook(input, { credentials });
    assert.equal(first.status, "submitted");
    assert.equal(requests.length, 2);
    assert.equal(requests[0].init.headers.Authorization, "Bearer test-key");
    assert.equal(requests[0].init.headers["Content-Type"], undefined);

    const second = await syncRepositoryFromHook(input, { credentials });
    assert.equal(second.status, "skipped");
    assert.equal(second.reason, "already-submitted");
    assert.equal(requests.length, 2);

    const stateFiles = execFileSync("find", [stateDir, "-type", "f"], { encoding: "utf8" })
      .trim().split("\n").filter(Boolean);
    assert.equal(stateFiles.length, 1);
    assert.equal(JSON.parse(readFileSync(stateFiles[0], "utf8")).code.taskId, "task-1");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.OPENVIKING_REPOSITORY_SYNC_STATE_DIR;
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("prepareRepositoryUploadInputs and createWikiArchive publish only the Wiki allowlist", async () => {
  const root = createRepository();
  try {
    const context = await resolveRepositoryContext(root);
    const wikiRoot = writeWiki(root, context.commit);
    mkdirSync(join(wikiRoot, "user-profile"), { recursive: true });
    writeFileSync(join(wikiRoot, "user-profile", "preferences.md"), "private\n");
    const prepared = await prepareRepositoryUploadInputs(
      context,
      { baseUrl: "http://127.0.0.1:1933", user: "alice" },
      { wikiUploadEnabled: true },
    );
    assert.equal(prepared.wiki.status, "ready");
    assert.equal(prepared.wiki.targetUri, `viking://resources/wiki/${context.repoId}/alice`);
    assert.deepEqual(prepared.wiki.files, [
      "PROFILE.md",
      "architecture.md",
      "resources/commits.md",
      "resources/issues.md",
      "resources/prs.md",
    ]);
    assert.doesNotMatch(prepared.wiki.contents.get("architecture.md"), new RegExp(root));

    const bundle = await createWikiArchive(context, prepared.wiki);
    try {
      const listing = execFileSync("unzip", ["-Z1", bundle.archive], { encoding: "utf8" });
      assert.match(listing, /PROFILE\.md/u);
      assert.match(listing, /repo-wiki-manifest\.json/u);
      assert.doesNotMatch(listing, /raw\//u);
      assert.doesNotMatch(listing, /user-profile/u);
      assert.doesNotMatch(listing, /_plan\.md/u);
    } finally {
      await bundle.cleanup();
    }

    symlinkSync(join(root, "README.md"), join(wikiRoot, "unsafe.md"));
    const unsafe = await prepareRepositoryUploadInputs(
      context,
      { baseUrl: "http://127.0.0.1:1933", user: "alice" },
      { wikiUploadEnabled: true },
    );
    assert.equal(unsafe.wiki.status, "invalid");
    assert.match(unsafe.wiki.reason, /unsafe symlink/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareRepositoryUploadInputs rejects unknown Wiki resource files", async () => {
  const root = createRepository();
  try {
    const context = await resolveRepositoryContext(root);
    const wikiRoot = writeWiki(root, context.commit);
    writeFileSync(join(wikiRoot, "resources", "private.md"), "must not publish\n");
    const prepared = await prepareRepositoryUploadInputs(
      context,
      { baseUrl: "http://127.0.0.1:1933", user: "alice" },
      { wikiUploadEnabled: true },
    );
    assert.equal(prepared.wiki.status, "invalid");
    assert.match(prepared.wiki.reason, /unsupported resource entry/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("syncRepositoryFromHook publishes a Wiki built before later code changes by content hash", async () => {
  const root = createRepository();
  const stateDir = mkdtempSync(join(tmpdir(), "openviking-repository-wiki-state-"));
  const originalFetch = globalThis.fetch;
  process.env.OPENVIKING_REPOSITORY_SYNC_STATE_DIR = stateDir;
  const resourceBodies = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/resources/temp_upload")) {
      const name = init.body.get("file").name;
      return new Response(JSON.stringify({
        status: "ok",
        result: { temp_file_id: name.includes("-wiki") ? "wiki.zip" : "code.zip" },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const body = JSON.parse(init.body);
    resourceBodies.push(body);
    return new Response(JSON.stringify({
      status: "ok",
      result: { status: "success", task_id: `task-${body.temp_file_id}`, root_uri: body.to },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const wikiContext = await resolveRepositoryContext(root);
    writeWiki(root, wikiContext.commit);
    writeFileSync(join(root, "README.md"), "# repository after Wiki build\n");
    git(root, "add", "README.md");
    git(root, "commit", "-m", "code changed after Wiki build");
    const context = await resolveRepositoryContext(root);
    const input = {
      tool_name: "Bash",
      tool_input: { command: "git commit -m initial" },
      tool_response: { exit_code: 0 },
      cwd: root,
    };
    const credentials = {
      baseUrl: "http://127.0.0.1:1933",
      apiKey: "test-key",
      account: "account",
      user: "alice",
      peerId: "",
    };
    const first = await syncRepositoryFromHook(input, { credentials, wikiUploadEnabled: true });
    assert.equal(first.status, "submitted");
    assert.equal(first.code.status, "submitted");
    assert.equal(first.wiki.status, "submitted");
    assert.equal(resourceBodies.length, 2);
    const code = resourceBodies.find((body) => body.args?.git_local);
    const wiki = resourceBodies.find((body) => body.args?.parse_mode === "no_split");
    assert.equal(code.temp_file_id, "code.zip");
    assert.equal(wiki.temp_file_id, "wiki.zip");
    assert.equal(wiki.processing_mode, "vectors_only");
    assert.equal(wiki.wait, false);
    assert.equal(wiki.args.git_local, undefined);
    assert.ok(wiki.tags.includes("content_kind=repo_wiki"));
    assert.ok(wiki.tags.some((tag) => tag.startsWith("content_hash=")));
    assert.ok(wiki.tags.includes(`source_commit=${wikiContext.commit}`));
    assert.equal(wiki.tags.includes(`source_commit=${context.commit}`), false);
    assert.equal(wiki.to, `viking://resources/wiki/${context.repoId}/alice`);

    const second = await syncRepositoryFromHook(input, { credentials, wikiUploadEnabled: true });
    assert.equal(second.status, "skipped");
    assert.equal(resourceBodies.length, 2);
    const stateFile = execFileSync("find", [stateDir, "-type", "f"], { encoding: "utf8" })
      .trim().split("\n").find((file) => file.endsWith(".json"));
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.version, 2);
    assert.equal(state.code.taskId, "task-code.zip");
    assert.equal(state.wiki.taskId, "task-wiki.zip");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.OPENVIKING_REPOSITORY_SYNC_STATE_DIR;
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a failed Wiki upload can retry without resubmitting code", async () => {
  const root = createRepository();
  const stateDir = mkdtempSync(join(tmpdir(), "openviking-repository-retry-state-"));
  const originalFetch = globalThis.fetch;
  process.env.OPENVIKING_REPOSITORY_SYNC_STATE_DIR = stateDir;
  let wikiFailures = 1;
  let codeSubmits = 0;
  let wikiSubmits = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/resources/temp_upload")) {
      const name = init.body.get("file").name;
      return new Response(JSON.stringify({
        status: "ok", result: { temp_file_id: name.includes("-wiki") ? "wiki.zip" : "code.zip" },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const body = JSON.parse(init.body);
    if (body.temp_file_id === "code.zip") codeSubmits += 1;
    else {
      wikiSubmits += 1;
      if (wikiFailures-- > 0) {
        return new Response(JSON.stringify({ status: "error", error: { message: "wiki failed" } }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({
      status: "ok", result: { status: "success", task_id: `task-${body.temp_file_id}`, root_uri: body.to },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const context = await resolveRepositoryContext(root);
    writeWiki(root, context.commit);
    const input = {
      tool_name: "Bash", tool_input: { command: "git commit -m initial" },
      tool_response: { exit_code: 0 }, cwd: root,
    };
    const credentials = { baseUrl: "http://127.0.0.1:1933", user: "alice" };
    const first = await syncRepositoryFromHook(input, { credentials, wikiUploadEnabled: true });
    assert.equal(first.status, "partial");
    assert.equal(first.code.status, "submitted");
    assert.equal(first.wiki.status, "failed");

    const second = await syncRepositoryFromHook(input, { credentials, wikiUploadEnabled: true });
    assert.equal(second.status, "submitted");
    assert.equal(second.code.status, "skipped");
    assert.equal(second.wiki.status, "submitted");
    assert.equal(codeSubmits, 1);
    assert.equal(wikiSubmits, 2);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.OPENVIKING_REPOSITORY_SYNC_STATE_DIR;
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});
