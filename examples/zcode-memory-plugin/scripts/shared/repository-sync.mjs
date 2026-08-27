// GENERATED FROM examples/memory-plugin-shared/lib. DO NOT EDIT.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

import { resolveOpenVikingCredentials } from "./credentials.mjs";

const execFileAsync = promisify(execFile);
const MUTATING_GIT_COMMANDS = new Set([
  "checkout",
  "commit",
  "merge",
  "pull",
  "rebase",
  "reset",
  "revert",
  "switch",
]);
const STATE_DIR_MODE = 0o700;
const STATE_FILE_MODE = 0o600;

function hash(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function safePart(value, fallback = "unknown") {
  const normalized = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (normalized || fallback).slice(0, 96);
}

function branchTargetSegment(branch) {
  const raw = String(branch || "").trim();
  const normalized = safePart(raw);
  if (normalized === raw && raw.length <= 96) return normalized;
  return `${normalized.slice(0, 87)}-${hash(raw).slice(0, 8)}`;
}

function shellWords(command) {
  return String(command || "").trim().split(/\s+/u);
}

function commandText(input = {}) {
  const toolInput = input.tool_input ?? input.toolInput ?? input.input ?? input.arguments ?? {};
  return typeof toolInput === "string"
    ? toolInput
    : String(toolInput.command ?? toolInput.cmd ?? toolInput.script ?? "");
}

export function isSuccessfulGitMutation(input = {}) {
  const toolName = String(input.tool_name ?? input.toolName ?? input.name ?? input.tool ?? "");
  if (!/^(Bash|RunCommand|Shell|exec_command|codex_exec)$/u.test(toolName)) return false;

  const response = input.tool_response ?? input.toolResponse ?? input.response ?? {};
  if (response && typeof response === "object") {
    const code = response.exit_code ?? response.exitCode ?? response.code;
    if (Number.isFinite(Number(code)) && Number(code) !== 0) return false;
    const status = String(response.status ?? "").toLowerCase();
    if (["error", "failed", "failure"].includes(status)) return false;
    if (response.success === false) return false;
  }

  const command = commandText(input);
  if (!command) return false;
  const invocations = command.match(/(?:^|(?:&&|;|\|\|)\s*)git\s+([A-Za-z-]+)/gu) || [];
  return invocations.some((entry) => {
    const words = shellWords(entry.replace(/^(?:&&|;|\|\|)\s*/u, ""));
    return words[0] === "git" && MUTATING_GIT_COMMANDS.has(words[1]);
  });
}

async function runGit(cwd, args, timeout = 15_000) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

function stripRemoteCredentials(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    return raw.replace(/^(https?:\/\/)[^/@]+@/u, "$1");
  }
}

export async function resolveRepositoryContext(cwd) {
  const root = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  const commit = await runGit(root, ["rev-parse", "HEAD"]);
  let branch = await runGit(root, ["branch", "--show-current"]);
  if (!branch) branch = `detached-${commit.slice(0, 12)}`;

  let origin = "";
  try {
    origin = stripRemoteCredentials(await runGit(root, ["remote", "get-url", "origin"]));
  } catch {
    // Local-only repositories are identified without publishing their path.
  }
  const repoKey = origin || `local:${hash(root)}`;
  return {
    root,
    commit: commit.toLowerCase(),
    branch,
    repoKey,
    repoName: basename(root),
    targetUri: `viking://resources/local-git/${hash(repoKey).slice(0, 24)}/${branchTargetSegment(branch)}`,
  };
}

function statePath(context) {
  const root = process.env.OPENVIKING_REPOSITORY_SYNC_STATE_DIR
    || join(process.env.HOME || tmpdir(), ".openviking", "repository-sync", "state");
  return join(root, `${hash(`${context.repoKey}\n${context.branch}`)}.json`);
}

function lockPath(context) {
  return `${statePath(context)}.lock`;
}

async function withRepositoryLock(context, callback) {
  const lock = lockPath(context);
  await mkdir(dirname(lock), { recursive: true, mode: STATE_DIR_MODE });
  while (true) {
    try {
      await mkdir(lock, { mode: STATE_DIR_MODE });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - (await stat(lock)).mtimeMs > 10 * 60_000) {
          await rm(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      return { status: "skipped", reason: "already-running", context };
    }
  }
  try {
    return await callback();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

async function readState(context) {
  try {
    return JSON.parse(await readFile(statePath(context), "utf8"));
  } catch {
    return {};
  }
}

async function writeState(context, value) {
  const file = statePath(context);
  await mkdir(dirname(file), { recursive: true, mode: STATE_DIR_MODE });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: STATE_FILE_MODE,
  });
  await rename(temporary, file);
}

export async function createRepositoryArchive(context) {
  const directory = await mkdtemp(join(tmpdir(), "openviking-git-local-"));
  await chmod(directory, STATE_DIR_MODE);
  const archive = join(directory, `${safePart(context.repoName, "repository")}.zip`);
  await execFileAsync(
    "git",
    ["-C", context.root, "archive", "--format=zip", `--output=${archive}`, "HEAD"],
    { timeout: 120_000, maxBuffer: 1024 * 1024 },
  );
  await chmod(archive, STATE_FILE_MODE);
  return { archive, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

function authHeaders(credentials, contentType = "") {
  const headers = {};
  if (contentType) headers["Content-Type"] = contentType;
  if (credentials.apiKey) headers.Authorization = `Bearer ${credentials.apiKey}`;
  if (credentials.account) headers["X-OpenViking-Account"] = credentials.account;
  if (credentials.user) headers["X-OpenViking-User"] = credentials.user;
  if (credentials.peerId) headers["X-OpenViking-Actor-Peer"] = credentials.peerId;
  return headers;
}

async function responseResult(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.status === "error") {
    const message = body.error?.message || body.message || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body.result ?? body;
}

export async function uploadRepositorySnapshot(credentials, archive) {
  const form = new FormData();
  const { openAsBlob } = await import("node:fs");
  const content = typeof openAsBlob === "function"
    ? await openAsBlob(archive, { type: "application/zip" })
    : new Blob([await readFile(archive)], { type: "application/zip" });
  form.append("file", content, basename(archive));
  const response = await fetch(`${credentials.baseUrl}/api/v1/resources/temp_upload`, {
    method: "POST",
    headers: authHeaders(credentials),
    body: form,
  });
  const result = await responseResult(response);
  if (!result.temp_file_id) throw new Error("Temporary upload returned no temp_file_id.");
  return result.temp_file_id;
}

export async function submitRepositorySnapshot(credentials, tempFileId, context) {
  const response = await fetch(`${credentials.baseUrl}/api/v1/resources`, {
    method: "POST",
    headers: authHeaders(credentials, "application/json"),
    body: JSON.stringify({
      temp_file_id: tempFileId,
      to: context.targetUri,
      wait: false,
      args: {
        git_local: {
          version: 1,
          repo_key: context.repoKey,
          repo_name: context.repoName,
          branch: context.branch,
          commit: context.commit,
          archive_format: "zip",
        },
      },
    }),
  });
  return responseResult(response);
}

export async function syncRepositoryFromHook(input, options = {}) {
  if (!isSuccessfulGitMutation(input)) return { status: "skipped", reason: "not-git-mutation" };
  const cwd = String(input.cwd || process.cwd());
  const context = await resolveRepositoryContext(cwd);
  return withRepositoryLock(context, async () => {
    const previous = await readState(context);
    if (previous.lastSubmittedCommit === context.commit) {
      return { status: "skipped", reason: "already-submitted", context };
    }

    const credentials = options.credentials || resolveOpenVikingCredentials();
    const bundle = await createRepositoryArchive(context);
    try {
      const tempFileId = await uploadRepositorySnapshot(credentials, bundle.archive);
      const result = await submitRepositorySnapshot(credentials, tempFileId, context);
      await writeState(context, {
        version: 1,
        repoKey: context.repoKey,
        branch: context.branch,
        targetUri: context.targetUri,
        lastSubmittedCommit: context.commit,
        taskId: result.task_id || "",
        updatedAt: new Date().toISOString(),
      });
      return { status: "submitted", context, result };
    } finally {
      await bundle.cleanup();
    }
  });
}
