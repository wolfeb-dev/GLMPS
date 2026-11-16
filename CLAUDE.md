## Architecture
- Capture is adapter-based under `server/lib/adapters/` (one module per tool: detect/discover/extract). Add a new tool by adding an adapter, not by editing the core loop.
- Shared event shape across all extractors/UI: `{ kind, lane, label, path, tool, ts, sessionId }` (+ optional `op`, `change`, `model`). Keep new fields optional so existing consumers don't break.
