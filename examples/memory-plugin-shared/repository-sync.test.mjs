import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createRepositoryArchive,
  isSuccessfulGitMutation,
  resolveRepositoryContext,
  syncRepositoryFromHook,
} from "./lib/repository-sync.mjs";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function createRepository({ remote = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "openviking-repository-sync-"));
  git(root, "init");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "OpenViking Test");
  writeFileSync(join(root, ".gitignore"), "*.log\n");
  writeFileSync(join(root, "README.md"), "# repository\n");
  writeFileSync(join(root, "ignored.log"), "ignored\n");
  git(root, "add", ".gitignore", "README.md");
  git(root, "commit", "-m", "initial");
  if (remote) git(root, "remote", "add", "origin", "https://example.test/org/repository.git");
  return root;
}

test("isSuccessfulGitMutation accepts Codex event payloads and rejects reads or failures", () => {
  assert.equal(isSuccessfulGitMutation({
    tool_name: "Bash",
    tool_input: { command: "git commit -m test" },
    tool_response: { exit_code: 0 },
  }), true);
  assert.equal(isSuccessfulGitMutation({
    tool_name: "exec_command",
    tool_input: { cmd: "git commit -m test" },
    tool_response: { exit_code: 0 },
  }), true);
  assert.equal(isSuccessfulGitMutation({
    tool_name: "exec_command",
    tool_input: { cmd: "git status" },
    tool_response: { exit_code: 0 },
  }), false);
  assert.equal(isSuccessfulGitMutation({
    tool_name: "codex_exec",
    tool_input: { cmd: "git pull --rebase" },
    tool_response: { exit_code: 1 },
  }), false);
  assert.equal(isSuccessfulGitMutation({
    tool_name: "exec_command",
    command: ["/bin/bash", "-lc", "git commit -m test"],
    cwd: "/repo",
    exit_code: 0,
    status: "completed",
  }), true);
  assert.equal(isSuccessfulGitMutation({
    tool_name: "Bash",
    tool_input: { command: 'echo "git commit -m test"' },
    tool_response: { exit_code: 0 },
  }), false);
});

test("createRepositoryArchive contains committed HEAD files only", async () => {
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

test("local repository identity persists without exposing the checkout path", async () => {
  const root = createRepository();
  try {
    const first = await resolveRepositoryContext(root);
    const second = await resolveRepositoryContext(root);
    assert.equal(first.repoKey, second.repoKey);
    assert.match(first.repoKey, /^local:[0-9a-f-]+$/u);
    assert.equal(first.repoKey.includes(root), false);
    assert.match(git(root, "config", "--local", "--get", "openviking.repositoryKey"), /^[0-9a-f-]+$/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("syncRepositoryFromHook skips remote-backed repositories", async () => {
  const root = createRepository({ remote: true });
  try {
    const result = await syncRepositoryFromHook({
      tool_name: "exec_command",
      tool_input: { cmd: "git commit --allow-empty -m test" },
      tool_response: { exit_code: 0 },
      cwd: root,
    });
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "remote-backed");
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
    tool_name: "exec_command",
    tool_input: { cmd: "git commit -m initial" },
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
    assert.equal(JSON.parse(readFileSync(stateFiles[0], "utf8")).taskId, "task-1");
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.OPENVIKING_REPOSITORY_SYNC_STATE_DIR;
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});
