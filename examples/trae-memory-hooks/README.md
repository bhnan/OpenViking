# OpenViking Memory Hooks for TRAE

This package provides dedicated TRAE and TRAE CN lifecycle adapters. It does not reuse Claude Code transcript parsing: TRAE capture reads `prompt`, `text_content`, and `last_assistant_message` from the `Stop` event and stores sessions with `tr-` or `trcn-` prefixes.

Its `PreToolUse` guard prevents `viking://` virtual paths from being passed to local file or shell tools and points the Agent back to OpenViking MCP tools.

Its `PostToolUse` repository hook watches successful Git commands that can
change `HEAD`, uploads a committed `git archive HEAD` snapshot, and updates a
stable resource for the current repository and branch. Read-only commands such
as `git status` and `git diff` do not upload anything.

Use the shared installer:

```bash
bash examples/memory-plugin-shared/install.sh --harness trae,trae-cn
```

See the [TRAE integration guide](../../docs/en/agent-integrations/13-trae.md).
