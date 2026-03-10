---
summary: 'Token-backed Attio MCP server for mcporter, including setup, supported tools, and team rollout guidance.'
read_when:
  - 'You need a reliable Attio MCP that runs through mcporter instead of Attio hosted OAuth'
  - 'Rolling out the local Attio MCP server to teammates'
---

# Attio MCP Server

mcporter now ships a local stdio MCP server for Attio under `pnpm attio:mcp`. It is intended for teams that want a reliable Attio integration without depending on the hosted `https://mcp.attio.com/mcp` OAuth flow.

## Why this exists

Attio's hosted MCP is useful when its OAuth path is healthy, but it adds a remote auth dependency that mcporter cannot control. The local server keeps the architecture simple:

- `mcporter` launches a stdio MCP process.
- The MCP process calls the public Attio REST API directly.
- Authentication is a normal Attio API token in the environment.

That makes the integration easier to debug, easier to share across a team, and easier to run in CI or on headless machines.

## Supported tools

The server intentionally exposes only the public REST API surface that is clearly documented today:

- `list-objects`
- `list-attribute-definitions`
- `search-records`
- `list-records`
- `get-record`
- `create-record`
- `assert-record`
- `list-notes`
- `get-note`
- `create-note`
- `list-tasks`
- `get-task`
- `create-task`
- `update-task`
- `list-workspace-members`
- `get-workspace-member`

It does not attempt to mirror hosted-only capabilities such as semantic search over calls/emails or workspace helpers that are not clearly backed by the public REST API.

## Environment variables

- `ATTIO_API_TOKEN`
  Preferred Attio token.
- `ATTIO_API_KEY`
  Fallback alias.
- `ATTIO_ACCESS_TOKEN`
  Fallback alias.
- `ATTIO_API_URL`
  Optional override. Defaults to `https://api.attio.com/v2`.

## Quick smoke test

Run the server directly:

```bash
ATTIO_API_TOKEN=your-token-here pnpm attio:mcp
```

In another shell, point mcporter at it ad hoc:

```bash
ATTIO_API_TOKEN=your-token-here \
pnpm exec tsx src/cli.ts list --stdio "pnpm --dir $(pwd) attio:mcp" --name attio-local
```

Or call a tool:

```bash
ATTIO_API_TOKEN=your-token-here \
pnpm exec tsx src/cli.ts call --stdio "pnpm --dir $(pwd) attio:mcp" --name attio-local \
  'attio-local.list-objects()'
```

## Team config

For a shared mcporter config, add a named stdio server that points at this repo:

```json
{
  "mcpServers": {
    "attio": {
      "description": "Attio REST-backed MCP server",
      "command": "pnpm",
      "args": ["--dir", "/absolute/path/to/mcporter", "attio:mcp"],
      "env": {
        "ATTIO_API_TOKEN": "${ATTIO_API_TOKEN}"
      }
    }
  }
}
```

If your team uses a custom API base or a proxy, add:

```json
{
  "ATTIO_API_URL": "https://api.attio.com/v2"
}
```

Then verify:

```bash
npx mcporter list attio
npx mcporter call 'attio.list-objects()'
```

## Operational notes

- The server is stdio-only by design. mcporter handles lifecycle and output formatting.
- Results include both text output and structured JSON payloads so human CLI use and scripted use share the same tool handlers.
- Token rotation is just an environment update. No OAuth cache reset is needed.

## Verification inside this repo

The Attio MCP integration test launches the server through mcporter and checks real MCP round-trips against a mocked Attio API:

```bash
./runner pnpm exec vitest run tests/attio-stdio.integration.test.ts
```

For full repo gates:

```bash
./runner pnpm check
./runner pnpm build
```
