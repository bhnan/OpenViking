#!/usr/bin/env node

import {
  createAgentLogger,
  loadAgentHookConfig,
} from "../../memory-plugin-shared/lib/agent-hook-runtime.mjs";
import { maybeDetach, readHookStdin } from "../../memory-plugin-shared/lib/async-writer.mjs";
import { syncRepositoryFromHook } from "../../memory-plugin-shared/lib/repository-sync.mjs";

const cfg = loadAgentHookConfig("trae-cli");
const { log, logError } = createAgentLogger("trae-cli", "post-tool-use:repository-sync", cfg);

function output(value = {}) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main() {
  if (!cfg.enabled || process.env.OPENVIKING_GIT_LOCAL_ENABLED === "0") {
    output({});
    return;
  }
  if (await maybeDetach(cfg, { approve: () => output({}) })) return;

  let input = {};
  try {
    const raw = await readHookStdin();
    input = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    output({});
    return;
  }

  const result = await syncRepositoryFromHook(input).catch((error) => {
    logError("repository-sync", error);
    return { status: "error", error: error?.message || String(error) };
  });
  log("repository-sync", {
    status: result?.status,
    reason: result?.reason,
    task_id: result?.result?.task_id,
    root_uri: result?.result?.root_uri,
  });
  if (process.env.OV_HOOK_WORKER !== "1") output({});
}

await main();
