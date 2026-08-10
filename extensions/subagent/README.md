# @yu1745/pi-subagent

Adds an agent-callable `subagent` tool that runs isolated Pi subprocesses. Each child receives a standalone brief rather than the parent conversation and reports back when done. The child always inherits the parent session's current model.

## Install

```bash
pi install git:github.com/yu1745/pi-subagent
```

> Forked from `@howaboua/pi-explore-subagents` (MIT, upstream:
> `IgorWarzocha/howaboua-pi-stuff/packages/pi-explore-subagents`).
> **Fork changes:**
> - model selection removed — the subagent always uses the parent session's model
> - added a `task` mode (general-purpose worker that may edit files)
> - renamed tool `explore_subagent` → `subagent` (the package is no longer discovery-only)

## Modes

| Mode | Reads | Writes | Purpose |
|------|:-----:|:------:|---------|
| `shallow` | ✅ | ❌ | Bounded recon — hotspots, entry points, narrow questions, best next reads |
| `deep` | ✅ | ❌ | Broad surveys, cross-file tracing, triage, compare/rank |
| `task` | ✅ | ✅ | General-purpose work — implement, refactor, fix, generate. Returns a changed-files manifest |

`shallow` and `deep` are discovery-only (read tools). `task` is a full worker: it may read, write, edit, and run commands, and its prompt requires the final output to include a **Changed Files** section listing every file created/modified/deleted.

The tool accepts a required `task`, a required `mode`, and an optional `cwd`. Because the child has no inherited conversation, include background, exact goal, scope, constraints, and expected output in the task.

Users normally ask Pi in plain language rather than calling the tool directly:

> Use a shallow subagent to find where authentication errors are rendered. Stay discovery-only and return likely files, line ranges, and the best next reads.

> Use a task subagent to extract the retry logic in `src/api.ts` into a helper. Verify it still typechecks.

## Configuration

On first use, the extension creates `~/.pi/agent/pi-subagent.json` (or the equivalent path under `$PI_CODING_AGENT_DIR`).

```json
{
  "shallow": { "thinking": "low" },
  "deep": { "thinking": "low" },
  "task": { "thinking": "medium" }
}
```

There is **no model setting** — the subagent always runs on whatever model the parent Pi session is currently using. Change `/model` in Pi and the subagent follows automatically. If no active parent model exists, the tool errors with a clear message.

Only `thinking` is configurable per mode. Thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (clamped to model capability).

> **Note for users upgrading from `@howaboua/pi-explore-subagents`:** the config file was renamed from `pi-explore-subagents.json` to `pi-subagent.json`. The old file is ignored — you can delete it.
