# Theory: A Stable Attio MCP for mcporter

## Problem

The immediate problem is not that Attio lacks an MCP server. Attio already ships a hosted MCP endpoint at `https://mcp.attio.com/mcp`. The problem is that the team needs an Attio integration that works reliably through mcporter, and the hosted path depends on remote OAuth behavior, connector assumptions, and approval semantics that are outside this repository's control. When that path fails, the integration is blocked even though Attio's public REST API remains available. The repository therefore needs a version of the Attio MCP story that mcporter can own end to end: process startup, auth model, tool schema, verification, and documentation.

## Operating Theory

mcporter is strongest when it launches a well-behaved stdio MCP server under local control. That removes hosted-server ambiguity and lets mcporter do what it already does well: spawn the process, cache the definition, expose the tools, and let teams share a stable config snippet. Attio's public REST API is rich enough to support the core CRM workflows that matter most for agents and operators: records, objects, attributes, notes, tasks, and workspace members. The hosted Attio MCP goes further into AI-native search over calls and emails, but those capabilities are not obviously backed by the public REST API and should not be guessed at.

The server should not live as a throwaway example. It needs to be usable as a real team integration. That means the implementation has to satisfy mcporter's typed MCP SDK constraints, ship a stable entrypoint (`pnpm attio:mcp`), and be documented as a shared config pattern rather than only as a test harness. That theory is now validated: the server compiles, the repo type/lint gates pass, and the integration test proves the stdio transport plus REST proxy path together.

## Strategy

Build a first-party stdio MCP server inside this repo that authenticates with an Attio API token and presents a deliberate subset of the hosted Attio MCP surface. Match the hosted naming style where possible so prompts stay portable, but only expose tools that can be backed confidently by documented REST endpoints. The server should return structured JSON plus readable text summaries, because mcporter users need both machine-safe results and sensible terminal output.

Verification needs to prove two separate things. First, the server must speak MCP correctly over stdio. Second, the tool handlers must translate inputs into the expected Attio REST requests and shape the responses consistently. That means using integration tests that launch the stdio server through mcporter while talking to a mocked Attio HTTP server, rather than relying on unit tests or a README-only workflow. Documentation is part of the same strategy: if the server cannot be dropped into a shared config with one obvious snippet, it is not actually a team-ready solution. The current implementation follows that path by pairing the server with a dedicated rollout doc and a repo script entrypoint.

## Key Discoveries

Attio's official MCP overview confirms the hosted tool taxonomy: records, notes, tasks, meetings/calls, emails, and workspace helpers. The public REST documentation clearly supports records, attributes, notes, tasks, objects, lists, and workspace members via token-authenticated HTTPS endpoints. The mismatch matters: the hosted MCP advertises semantic search and workspace-team helpers that are not clearly present in the public REST surface. The right move is to ship the reliable public-API subset first and document the gap explicitly instead of overpromising parity.

The mcporter repo already contains the right patterns for this work. It has lightweight stdio MCP fixtures, runtime integration tests, and documentation for local/manual MCP validation. That means the Attio server can live in-tree without inventing a second harness or testing style.

The MCP SDK type constraints matter in practice. Returning readable text plus `structuredContent` is the right UX, but the structured payload must still satisfy the SDK's record-like contract. A narrowly declared interface is not enough; the result object has to be typed as a record intersection so the compiler accepts the MCP response shape.

The final leverage point was small but important: one type adjustment and one lint-safe request-body spread were enough to move the server from "works in tests but fails repo gates" to "fully integrated with the project's build discipline." That confirms the architecture was correct; the remaining breakage was adaptation to mcporter's quality bar, not a flaw in the Attio approach.

## Open Questions

The main open question is scope, not feasibility. It is still possible that some hosted Attio MCP capabilities map to public endpoints that are not obvious from the high-level docs, but the current evidence supports building around the documented core APIs only. If later investigation reveals public endpoints for team listing, current-user introspection, or semantic activity search, those can be added incrementally without changing the architecture.

The remaining uncertainty is deployment shape for the broader team. The repo now contains a working shared stdio server and documentation for local config, but a production rollout still depends on where the team wants this to live: this repository, a dedicated Attio MCP package, or an internal distribution point with versioned binaries. That is a packaging decision, not an implementation blocker.
