# drone-studio

Two products, one codebase.

| | Entry point | Lives in |
| --- | --- | --- |
| **Armable** — the drone bench: connect, inspect, test, tune, flash, read flight logs | `index.html` → `src/web/main.tsx`, served at `/` | `src/web` |
| **Armable Shows** — the drone-show studio: formations, keyframes, transitions, storyboards, audience and camera | `show.html` → `src/show/main.tsx`, served at `/show` | `src/show`, `src/core`, `src/components`, `src/audio`, `src/agent` |

Each has its own page, its own navigation and its own bundle. Neither leads through the other: there is no show
concept in the bench's information architecture, and no aircraft configuration on the way into a storyboard. One
link in the Armable menu goes across; one link in the Shows library header comes back.
[`src/show/boundary.test.ts`](src/show/boundary.test.ts) fails if either side starts importing the other.

## What they share

Underneath the two surfaces, nothing is duplicated:

| | |
| --- | --- |
| `src/device` | The device layer in the browser tab: MAVLink, MSP, ESC protocols, DFU flashing, transports, simulators |
| `src/aircraft` | Aircraft services, including `bench-show*.ts`, which compiles a storyboard into a bench plan — the one place the two products meet by design |
| `src/bench` | The bench an assistant drives over the live channel |
| `src/map` | The map of readings, tests, settings and guides that the `find` tool searches |
| `src/platform` | The cloud transport (`cloud.ts`), workspace navigation, shared visuals, the music model |
| `src/design-system` | Tokens and primitives, imported by both pages |
| `server` | One account, one document store, one MCP server. A live tab says which surface it is, so requests about the aircraft only ever reach a bench tab |

See the [main README](../README.md) to run it, and the [vision](docs/TOOL_APP_VISION.md),
[design](docs/TOOL_APP_DESIGN.md), [architecture](docs/TOOL_APP_ARCHITECTURE.md) and
[execution plan](docs/TOOL_APP_EXECUTION.md) for how it fits together.

```sh
npm ci
npm run build && npm run serve   # http://localhost:8787 and http://localhost:8787/show
npm run dev                      # http://localhost:5173 and http://localhost:5173/show
npm test                         # unit and integration tests
npm run e2e                      # browser tests (after a build)
```

The old local workspace is in [`archive/local-workspace`](../archive/local-workspace).
