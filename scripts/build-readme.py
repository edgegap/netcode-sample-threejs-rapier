"""Builds README.md from docs/edgegap-setup.md (the docs page source), so the two never drift.

    python scripts/build-readme.py
"""
import re
from pathlib import Path

root = Path(__file__).resolve().parent.parent
doc = (root / "docs/edgegap-setup.md").read_text(encoding="utf-8")
doc = re.sub(r"^---\n.*?\n---\n", "", doc, flags=re.S)          # frontmatter
doc = re.sub(r"^# .*\n", "", doc.lstrip(), count=1)                    # title (README has its own)
doc = doc.replace("This guide walks through that setup with a complete, open-source sample: "
                  "[netcode-sample-threejs-rapier](https://github.com/edgegap/netcode-sample-threejs-rapier).",
                  "This repository is that sample. The same guide is on the Edgegap docs: "
                  "[Make Your Browser (WebAssembly) Game Multiplayer]"
                  "(https://docs.edgegap.com/browser-webassembly-games/make-your-browser-game-multiplayer).")
doc = doc.replace("https://raw.githubusercontent.com/edgegap/netcode-sample-threejs-rapier/main/docs/images/", "docs/images/")

header = """# Browser Game Multiplayer with three.js, Rapier (WASM) and Edgegap

A reference sample for **browser game multiplayer**: a three.js game with **Rapier WebAssembly physics** and an **authoritative Node.js game server**, playable from any browser over secure WebSockets (`wss://`). The client is static files on a CDN; only a slim server image is deployed on [Edgegap](https://edgegap.com), which starts game servers on demand close to the players.

"""

versions = """
## Versions

Every dependency is pinned to an exact version (`package.json`, `package-lock.json`), and the base image by tag and digest.

| | Version |
| --- | --- |
| Node.js (server image) | 22.23.4 LTS, `node:22.23.4-alpine3.23` |
| Node.js (local development) | 22.12 or newer |
| three.js | 0.187.0 |
| Rapier (`@dimforge/rapier3d-compat`) | 0.21.0 |
| ws | 8.22.1 |
| Vite | 8.3.5 |
| TypeScript | 6.0.3 |
| **Server image size** | **63.5 MB compressed, 249 MB unpacked** (about 8 MB on top of the Node.js base image) |

`npm audit` reports a ReDoS advisory in `picomatch`, which Vite uses to match files during development. It affects every published `picomatch` version, is not part of the server image or the built page, and goes away when Vite updates the dependency.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Server on `:7777`, client on `:5173` with hot reload |
| `npm test` | Compiles the server and runs two headless players against it (`scripts/smoke-test.mjs`) |
| `SERVER_URL=wss://<host>:<port> node scripts/smoke-test.mjs` | The same test against a deployment |
| `npm run typecheck` | Type-checks server, shared and client |
| `npm run build -w client` | Builds the static client into `client/dist/` |
| `python scripts/build-readme.py` | Rebuilds this README from `docs/edgegap-setup.md` |

## License

[MIT](LICENSE). three.js (MIT), Rapier (Apache-2.0) and ws (MIT) keep their own licenses.
"""

(root / "README.md").write_text(header + doc.strip() + "\n" + versions, encoding="utf-8", newline="\n")
print("README.md written")
