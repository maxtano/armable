# drone-studio

The Armable app: the hosted interface (`src/web`), the device layer that runs in the browser tab (`src/device`), the map of readings, tests and settings (`src/map`), and the cloud service with the MCP server (`server`).

See the [main README](../README.md) to run it, and the [vision](docs/TOOL_APP_VISION.md), [design](docs/TOOL_APP_DESIGN.md), [architecture](docs/TOOL_APP_ARCHITECTURE.md) and [execution plan](docs/TOOL_APP_EXECUTION.md) for how it fits together.

```sh
npm ci
npm run build && npm run serve   # http://localhost:8787
npm test                         # unit and integration tests
npm run e2e                      # browser tests (after a build)
```

The old local workspace is in [`archive/local-workspace`](../archive/local-workspace).
