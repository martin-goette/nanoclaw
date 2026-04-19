# Design: Agent-Driven Model Switching

**Date:** 2026-04-19
**Status:** Approved (via brainstorming)

## Problem

Container agents always run on the model selected at startup (typically
Sonnet 1M). For complex tasks that need deeper reasoning, agents can't
escalate to Opus. Users with a Max plan could benefit from Opus on hard
problems while keeping Sonnet as the default for cost efficiency.

## Solution

Add a `set_model` MCP tool to the nanoclaw MCP server. The agent calls it
to switch models mid-session. The agent-runner picks up the switch between
`query()` calls.

## Mechanism

The MCP server and agent-runner are separate processes sharing
`/workspace/ipc/`. Communication uses a well-known file:

1. Agent calls `mcp__nanoclaw__set_model({ model: "opus" })`.
2. MCP server validates the model, writes `/workspace/ipc/model` containing
   the resolved model ID.
3. After each `runQuery()` returns, the agent-runner checks for
   `/workspace/ipc/model`. If present, reads the new model, deletes the
   file, and updates `currentModel`.
4. Next `runQuery()` call uses the new model.

### Tool Definition (ipc-mcp-stdio.ts)

```ts
server.tool(
  'set_model',
  'Switch the AI model for subsequent turns. Use "opus" for complex reasoning, "sonnet" for general tasks, "haiku" for simple relays. Changes take effect on the next turn.',
  {
    model: z.enum(['haiku', 'sonnet', 'opus']).describe('Model to switch to'),
  },
  async (args) => {
    const resolved = MODEL_MAP[args.model];
    fs.writeFileSync(
      path.join(IPC_DIR, 'model'),
      resolved,
      { mode: 0o644 },
    );
    return { content: [{ type: 'text', text: `Model set to ${args.model} (${resolved}). Takes effect next turn.` }] };
  },
);
```

Uses the existing `MODEL_MAP` already defined in the file (haiku, sonnet,
opus). Sonnet resolves to `claude-sonnet-4-6` (200k) — if 1M is desired,
the agent-runner can map plain sonnet to `SONNET_1M` when reading the file.

### Agent-Runner Changes (index.ts)

```ts
// After each runQuery(), before next loop iteration:
function checkModelSwitch(currentModel: string): string {
  const modelFile = '/workspace/ipc/model';
  try {
    if (!fs.existsSync(modelFile)) return currentModel;
    const newModel = fs.readFileSync(modelFile, 'utf-8').trim();
    fs.unlinkSync(modelFile);
    if (VALID_MODELS.has(newModel) && newModel !== currentModel) {
      log(`Model switched: ${currentModel} → ${newModel}`);
      return newModel;
    }
    return currentModel;
  } catch {
    return currentModel;
  }
}
```

- `selectedModel` becomes `let currentModel` (mutable).
- `checkModelSwitch(currentModel)` called after each `runQuery()` in the
  main loop + after the auto-save query.

## Model Names

Agents use friendly names (haiku, sonnet, opus). The MCP tool resolves
them via the existing `MODEL_MAP`. The agent-runner validates against
`VALID_MODELS` when reading the file.

Note: `MODEL_MAP` maps sonnet → `claude-sonnet-4-6` (200k). The
agent-runner should map this to `SONNET_1M` for interactive sessions
to preserve the 1M context benefit. Only the model file value
`claude-sonnet-4-6` needs this upgrade.

## No Guardrails

No usage limits, no justification required, no cost caps. The agent
decides freely. System prompt is not modified.

## Files Touched

| File | Change |
|---|---|
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Add `set_model` tool |
| `container/agent-runner/src/index.ts` | `checkModelSwitch()`, mutable `currentModel` |

## Out of Scope

- System prompt guidance on when to escalate.
- Per-group model restrictions.
- Logging/metrics of model switches to the host.
