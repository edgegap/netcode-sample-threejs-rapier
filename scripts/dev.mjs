// npm run dev: compile shared + server, start the server on :7777 and the Vite client on :5173.

import { spawn, spawnSync } from "node:child_process";

const shell = process.platform === "win32";
const run = (cmd, args) => spawn(cmd, args, { stdio: "inherit", shell });

const build = spawnSync("npx", ["tsc", "-b", "server"], { stdio: "inherit", shell });
if (build.status !== 0) process.exit(build.status ?? 1);

const server = run("node", ["server/dist/index.js"]);
const client = run("npm", ["run", "dev", "-w", "client"]);

console.log("\nOpen two tabs at http://localhost:5173/?server=localhost:7777\n");

const stop = () => {
  server.kill("SIGTERM");
  client.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
server.on("exit", (code) => {
  console.log(`server exited (${code})`);
  client.kill("SIGTERM");
  process.exit(code ?? 0);
});
