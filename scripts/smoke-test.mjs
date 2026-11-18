// Two headless players join, roll in different directions for a few seconds and check that the
// server moved them and that each sees the other.
//
//   npm test                                        # starts server/dist locally on a free port
//   SERVER_URL=wss://<host>:<port> node scripts/smoke-test.mjs   # against a deployment

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

const SECONDS = Number(process.env.SECONDS ?? 4);
let server = null;
let url = process.env.SERVER_URL;

if (!url) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  server = spawn(process.execPath, ["server/dist/index.js"], { env: { ...process.env, PORT: String(port) }, stdio: "inherit" });
  url = `ws://127.0.0.1:${port}`;
  await sleep(1500);
}

function player(name, dir) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const state = { name, id: 0, first: null, last: null, ack: 0, seenPlayers: 0, snapshots: 0 };
    let seq = 0;
    let timer;
    ws.on("open", () => ws.send(JSON.stringify({ t: "hello", name })));
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.t === "welcome") {
        state.id = msg.id;
        timer = setInterval(() => ws.send(JSON.stringify({ t: "input", seq: ++seq, x: dir[0], z: dir[1], jump: seq % 40 === 0 })), 1000 / 30);
        setTimeout(() => {
          clearInterval(timer);
          ws.close();
        }, SECONDS * 1000);
      } else if (msg.t === "snapshot") {
        state.snapshots++;
        state.ack = msg.ack;
        state.seenPlayers = Math.max(state.seenPlayers, msg.players.length);
        const me = msg.self.pose;
        if (!state.first) state.first = me;
        state.last = me;
      } else if (msg.t === "error") reject(new Error(msg.message));
    });
    ws.on("close", () => resolve(state));
    ws.on("error", reject);
  });
}

let ok = true;
try {
  const results = await Promise.all([player("alpha", [1, 0]), player("bravo", [0, -1])]);
  for (const r of results) {
    const moved = Math.hypot(r.last[0] - r.first[0], r.last[2] - r.first[2]);
    const pass = moved > 1 && r.seenPlayers === 2 && r.ack > 0;
    ok &&= pass;
    console.log(
      `${pass ? "PASS" : "FAIL"} ${r.name} #${r.id}: moved ${moved.toFixed(2)} m, ${r.snapshots} snapshots, ack ${r.ack}, saw ${r.seenPlayers} players`
    );
  }
} catch (err) {
  ok = false;
  console.log(`FAIL ${err.message}`);
}
server?.kill("SIGTERM");
console.log(ok ? "smoke test passed" : "smoke test FAILED");
process.exit(ok ? 0 : 1);
