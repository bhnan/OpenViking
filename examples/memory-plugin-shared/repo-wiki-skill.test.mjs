import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const canonicalSkill = join(root, "examples", "skills", "repo-wiki");
const collect = join(canonicalSkill, "scripts", "collect_all.py");
const detect = join(canonicalSkill, "scripts", "detect_updates.py");
const validate = join(canonicalSkill, "scripts", "validate_memory.py");

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function createRepo() {
  const repo = mkdtempSync(join(tmpdir(), "openviking-repo-wiki-skill-"));
  git(repo, "init");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "OpenViking Test");
  writeFileSync(join(repo, "README.md"), "# Test repository\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "initial");
  return repo;
}

function runPython(script, args) {
  return execFileSync("python3", [script, ...args], { encoding: "utf8" });
}

function relativeFiles(directory, prefix = "") {
  return readdirSync(join(directory, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const relative = join(prefix, entry.name);
      return entry.isDirectory() ? relativeFiles(directory, relative) : [relative];
    })
    .sort();
}

function writeValidWiki(repo, head, tree) {
  const wiki = join(repo, ".repo_memory");
  mkdirSync(join(wiki, "resources"), { recursive: true });
  writeFileSync(join(wiki, "PROFILE.md"), [
    "---",
    'schema: "repo_memory_profile.v0.2"',
    'source_repo_path: "."',
    `local_head: "${head}"`,
    `source_tree: "${tree}"`,
    "---",
    "# Test Wiki",
    "[Architecture](architecture.md)",
    "",
  ].join("\n"));
  writeFileSync(join(wiki, "architecture.md"), [
    "---",
    'schema: "repo_memory_wiki_page.v0.1"',
    "---",
    "# Architecture",
    "",
  ].join("\n"));
  writeFileSync(join(wiki, "resources", "commits.md"), [
    "---",
    'schema: "repo_memory_commit_resource.v0.1"',
    'source: "local_git"',
    "resource_count: 0",
    'trust_state: "draft_resource"',
    'raw_source: "../raw/git-commits.json"',
    "---",
    "# Commits",
    "",
  ].join("\n"));
  for (const name of ["prs.md", "issues.md"]) {
    const schema = name === "prs.md" ? "repo_memory_pr_resource.v0.1" : "repo_memory_issue_resource.v0.1";
    writeFileSync(join(wiki, "resources", name), [
      "---",
      `schema: "${schema}"`,
      'source: "provider_skipped_local_only"',
      "resource_count: 0",
      'trust_state: "unavailable_local_only"',
      'raw_source: ""',
      "---",
      `# ${name}`,
      "",
    ].join("\n"));
  }
}

test("canonical repo-wiki Skill is complete and self-contained", () => {
  const files = relativeFiles(canonicalSkill);
  assert.equal(files.length, 16);
  for (const file of files) {
    assert.ok(readFileSync(join(canonicalSkill, file), "utf8").length > 0, `${file} must not be empty`);
  }
  const allContent = files.map((file) => readFileSync(join(canonicalSkill, file), "utf8")).join("\n");
  assert.doesNotMatch(allContent, /memorax(?:-cli|-code)?/iu);
  assert.doesNotMatch(allContent, /procedure-memory|user-profile/iu);
});

test("repo-wiki helper scripts collect local-only evidence and detect freshness", () => {
  const repo = createRepo();
  try {
    const collected = JSON.parse(runPython(collect, [
      "--repo-path", repo,
      "--commit-limit", "5",
      "--pretty",
    ]));
    assert.equal(collected.ok, true);
    assert.equal(collected.effective_settings.history.mode, "local-only");
    assert.equal(collected.effective_settings.history.collect.provider, false);
    assert.equal(collected.provider.evidence_state, "skipped_by_policy");
    assert.deepEqual(collected.notices, []);
    assert.equal(collected.counts.raw.git_commits.commit, 1);
    assert.match(readFileSync(join(repo, ".gitignore"), "utf8"), /^\/?\.repo_memory\/$/mu);

    const head = git(repo, "rev-parse", "HEAD");
    const tree = git(repo, "rev-parse", "HEAD^{tree}");
    writeValidWiki(repo, head, tree);
    const valid = JSON.parse(runPython(validate, [repo, "--pretty"]));
    assert.equal(valid.ok, true);
    const current = JSON.parse(runPython(detect, ["--repo-path", repo, "--pretty"]));
    assert.equal(current.effective_settings.history.mode, "local-only");
    assert.equal(current.deltas.local_commit_status.status, "current");

    writeFileSync(join(repo, "README.md"), "# Changed repository\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-m", "change");
    const changed = JSON.parse(runPython(detect, ["--repo-path", repo, "--pretty"]));
    assert.equal(changed.deltas.local_commit_status.status, "ok");
    assert.ok(changed.deltas.local_commits.some((commit) => commit.files.includes("README.md")));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("validate_memory rejects a missing source_tree", () => {
  const repo = createRepo();
  try {
    const head = git(repo, "rev-parse", "HEAD");
    const tree = git(repo, "rev-parse", "HEAD^{tree}");
    writeValidWiki(repo, head, tree);
    const profile = join(repo, ".repo_memory", "PROFILE.md");
    writeFileSync(
      profile,
      readFileSync(profile, "utf8")
        .replace(/^source_tree:.*\n/mu, ""),
    );
    const result = JSON.parse(execFileSync(
      "python3", [validate, repo, "--pretty"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ));
    assert.equal(result.ok, false);
  } catch (error) {
    const result = JSON.parse(error.stdout);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((item) => item.includes("source_tree must be a full Git tree SHA")));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
