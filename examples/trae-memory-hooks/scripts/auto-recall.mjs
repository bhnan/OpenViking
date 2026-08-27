#!/usr/bin/env node

import { resolveTraeClient } from "./trae-client.mjs";

process.env.OPENVIKING_HOOK_EVENT = "user-prompt-submit";
process.env.OPENVIKING_HOOK_SOURCE = resolveTraeClient();
await import("./trae-hook.mjs");
