// three.js client: draws the arena, sends inputs, predicts its own ball and interpolates the rest.
//
// Server URL: the form, or ?server=host:port in the address bar (connects right away).
// Later, a matchmaker hands the client this address instead.

import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import {
  ARENA,
  CRATE,
  INTERPOLATION_DELAY_MS,
  PILLARS,
  PLAYER,
  TICK_DT,
  type InputCmd,
  type PlayerInfo,
  type Pose,
  type ServerMessage,
  type Snapshot,
} from "@sample/shared";
import { connect, toServerUrl, type Connection } from "./net";
import { Predictor } from "./prediction";

// Same WASM-in-JS compat build as the server: no .wasm file to host next to the page.
const rapierReady = RAPIER.init();

// --- DOM ---------------------------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const menu = $<HTMLFormElement>("menu");
const nameInput = $<HTMLInputElement>("name");
const serverInput = $<HTMLInputElement>("server");
const connectButton = $<HTMLButtonElement>("connect");
const statusBox = $<HTMLDivElement>("status");
const hud = $<HTMLDivElement>("hud");
const hudStatus = $<HTMLDivElement>("hud-status");

function setStatus(text: string, isError = false): void {
  statusBox.textContent = text;
  statusBox.classList.toggle("error", isError);
}

// --- Scene -------------------------------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
$("app").appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1b2a);
scene.fog = new THREE.Fog(0x0d1b2a, 30, 70);

const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);
camera.position.set(0, 16, 18);
camera.lookAt(0, 0, 0);

scene.add(new THREE.HemisphereLight(0xcfe7ff, 0x1b2a3a, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.position.set(8, 20, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16 });
scene.add(sun);

function resize(): void {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

// Arena meshes, built from the same constants as the Rapier colliders.
const floor = new THREE.Mesh(
  new THREE.BoxGeometry(ARENA.halfSize * 2, 1, ARENA.halfSize * 2),
  new THREE.MeshStandardMaterial({ color: 0x24425f })
);
floor.position.y = -0.5;
floor.receiveShadow = true;
scene.add(floor);
const grid = new THREE.GridHelper(ARENA.halfSize * 2, ARENA.halfSize * 2, 0x3c6488, 0x2f5170);
grid.position.y = 0.01;
scene.add(grid);

const wallMaterial = new THREE.MeshStandardMaterial({ color: 0x5b7c99 });
const t = ARENA.wallThickness;
const wallSpecs: Array<[number, number, number, number]> = [
  [0, ARENA.halfSize + t / 2, ARENA.halfSize * 2 + t * 2, t],
  [0, -ARENA.halfSize - t / 2, ARENA.halfSize * 2 + t * 2, t],
  [ARENA.halfSize + t / 2, 0, t, ARENA.halfSize * 2],
  [-ARENA.halfSize - t / 2, 0, t, ARENA.halfSize * 2],
];
for (const [x, z, w, d] of wallSpecs) {
  const wall = new THREE.Mesh(new THREE.BoxGeometry(w, ARENA.wallHeight, d), wallMaterial);
  wall.position.set(x, ARENA.wallHeight / 2, z);
  wall.castShadow = wall.receiveShadow = true;
  scene.add(wall);
}
for (const p of PILLARS) {
  const pillar = new THREE.Mesh(new THREE.BoxGeometry(p.halfX * 2, p.halfY * 2, p.halfZ * 2), wallMaterial);
  pillar.position.set(p.x, p.halfY, p.z);
  pillar.castShadow = pillar.receiveShadow = true;
  scene.add(pillar);
}

const crateGeometry = new THREE.BoxGeometry(CRATE.halfExtent * 2, CRATE.halfExtent * 2, CRATE.halfExtent * 2);
const crateMaterial = new THREE.MeshStandardMaterial({ color: 0xc8925a });
const crateMeshes: THREE.Mesh[] = [];
for (let i = 0; i < CRATE.count; i++) {
  const mesh = new THREE.Mesh(crateGeometry, crateMaterial);
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.visible = false;
  scene.add(mesh);
  crateMeshes.push(mesh);
}

// Player balls: a striped texture so you can see them roll.
function stripes(color: number): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 32;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
  ctx.fillRect(0, 0, 64, 32);
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillRect(0, 13, 64, 6);
  ctx.fillRect(28, 0, 8, 32);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function nameLabel(text: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.font = "bold 34px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(0, 8, 256, 48);
  ctx.fillStyle = "#fff";
  ctx.fillText(text, 128, 44);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false }));
  sprite.scale.set(2, 0.5, 1);
  return sprite;
}

interface PlayerView {
  info: PlayerInfo;
  ball: THREE.Mesh;
  label: THREE.Sprite;
}
const playerViews = new Map<number, PlayerView>();
const ballGeometry = new THREE.SphereGeometry(PLAYER.radius, 32, 16);

function addPlayer(info: PlayerInfo): void {
  if (playerViews.has(info.id)) return;
  const ball = new THREE.Mesh(ballGeometry, new THREE.MeshStandardMaterial({ map: stripes(info.color), roughness: 0.5 }));
  ball.castShadow = true;
  ball.visible = false;
  const label = nameLabel(info.id === myId ? `${info.name} (you)` : info.name);
  scene.add(ball, label);
  playerViews.set(info.id, { info, ball, label });
}

function removePlayer(id: number): void {
  const view = playerViews.get(id);
  if (!view) return;
  scene.remove(view.ball, view.label);
  playerViews.delete(id);
}

// --- Network state -----------------------------------------------------------------------------

let conn: Connection | null = null;
let serverUrl = "";
let myId = 0;
let predictor: Predictor | null = null;
let predictionOn = true;
let seq = 0;
const sentAt = new Map<number, number>();
let inputRttMs = 0;

/** Snapshots for interpolation, oldest first. */
const snapshots: Snapshot[] = [];
/** performance.now() minus server time (tick × tick length), smoothed. */
let clockOffset: number | null = null;

function onMessage(msg: ServerMessage): void {
  switch (msg.t) {
    case "welcome":
      myId = msg.id;
      msg.players.forEach(addPlayer);
      break;
    case "join":
      addPlayer(msg.player);
      break;
    case "leave":
      removePlayer(msg.id);
      break;
    case "snapshot":
      onSnapshot(msg);
      break;
    case "error":
      setStatus(msg.message, true);
      break;
  }
}

function onSnapshot(s: Snapshot): void {
  const serverTimeMs = s.tick * TICK_DT * 1000;
  const sample = performance.now() - serverTimeMs;
  clockOffset = clockOffset === null ? sample : clockOffset + (sample - clockOffset) * 0.05;
  snapshots.push(s);
  while (snapshots.length > 60) snapshots.shift();

  const sent = sentAt.get(s.ack);
  if (sent !== undefined) {
    inputRttMs = inputRttMs ? inputRttMs * 0.9 + (performance.now() - sent) * 0.1 : performance.now() - sent;
    for (const k of sentAt.keys()) if (k <= s.ack) sentAt.delete(k);
  }
  if (predictor && s.self) predictor.reconcile(s.ack, s.self);
}

async function start(rawServer: string, name: string): Promise<void> {
  connectButton.disabled = true;
  try {
    const target = toServerUrl(rawServer);
    if (target.warning) setStatus(target.warning);
    await rapierReady;
    predictor = new Predictor();
    conn = await connect(target.url, name, {
      onMessage,
      onStatus: (text) => setStatus(text),
      onClose: (reason) => stop(reason),
    });
    serverUrl = target.url;
    menu.hidden = true;
    hud.hidden = false;
    const params = new URLSearchParams(location.search);
    params.set("server", rawServer.trim());
    history.replaceState(null, "", `?${params}`);
  } catch (err) {
    setStatus((err as Error).message, true);
    console.error(err);
  } finally {
    connectButton.disabled = false;
  }
}

function stop(reason: string): void {
  conn = null;
  predictor = null;
  for (const id of [...playerViews.keys()]) removePlayer(id);
  crateMeshes.forEach((m) => (m.visible = false));
  snapshots.length = 0;
  clockOffset = null;
  menu.hidden = false;
  hud.hidden = true;
  setStatus(reason, true);
}

menu.addEventListener("submit", (e) => {
  e.preventDefault();
  localStorageSet("name", nameInput.value);
  void start(serverInput.value, nameInput.value);
});

// --- Input -------------------------------------------------------------------------------------

const keys = new Set<string>();
window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  keys.add(e.code);
  if (e.code === "KeyP") predictionOn = !predictionOn;
  if (e.code === "Space") e.preventDefault();
});
window.addEventListener("keyup", (e) => keys.delete(e.code));
window.addEventListener("blur", () => keys.clear());

function readInput(): InputCmd {
  const x = (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) - (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0);
  const z = (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0) - (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0);
  return { seq: ++seq, x, z, jump: keys.has("Space") };
}

// --- Interpolation -----------------------------------------------------------------------------

const tmpA = new THREE.Quaternion();
const tmpB = new THREE.Quaternion();

function lerpPose(a: Pose, b: Pose, k: number, out: THREE.Object3D): void {
  out.position.set(a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k);
  tmpA.set(a[3], a[4], a[5], a[6]);
  tmpB.set(b[3], b[4], b[5], b[6]);
  out.quaternion.slerpQuaternions(tmpA, tmpB, k);
}

/** Draw other players and crates INTERPOLATION_DELAY_MS in the past, between two snapshots. */
function renderInterpolated(): void {
  if (clockOffset === null || snapshots.length === 0) return;
  const renderTick = (performance.now() - clockOffset - INTERPOLATION_DELAY_MS) / (TICK_DT * 1000);
  let a = snapshots[0];
  let b = snapshots[0];
  for (let i = snapshots.length - 1; i >= 0; i--) {
    if (snapshots[i].tick <= renderTick) {
      a = snapshots[i];
      b = snapshots[i + 1] ?? snapshots[i];
      break;
    }
  }
  const k = b.tick > a.tick ? Math.min(1, (renderTick - a.tick) / (b.tick - a.tick)) : 0;

  a.crates.forEach((pose, i) => {
    crateMeshes[i].visible = true;
    lerpPose(pose, b.crates[i] ?? pose, k, crateMeshes[i]);
  });
  const next = new Map(b.players.map(([id, ...pose]) => [id, pose as Pose]));
  for (const [id, ...pose] of a.players) {
    const view = playerViews.get(id);
    if (!view || (id === myId && predictionOn)) continue;
    view.ball.visible = true;
    lerpPose(pose as Pose, next.get(id) ?? (pose as Pose), k, view.ball);
  }
}

// --- Main loop ---------------------------------------------------------------------------------

let last = performance.now();
let accumulator = 0;

function frame(now: number): void {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;

  if (conn && predictor) {
    // Fixed 30 Hz input + prediction steps, the server's tick rate.
    accumulator += dt;
    let steps = 0;
    while (accumulator >= TICK_DT && steps < 5) {
      const input = readInput();
      sentAt.set(input.seq, performance.now());
      conn.send({ t: "input", ...input });
      predictor.step(input);
      accumulator -= TICK_DT;
      steps++;
    }
    if (steps === 5) accumulator = 0;
    predictor.decayOffset(dt);

    renderInterpolated();

    const me = playerViews.get(myId);
    if (me && predictionOn) {
      const alpha = accumulator / TICK_DT;
      const p = predictor.position;
      const prev = predictor.previous;
      const off = predictor.visualOffset;
      me.ball.visible = true;
      me.ball.position.set(
        prev.x + (p.x - prev.x) * alpha + off.x,
        prev.y + (p.y - prev.y) * alpha + off.y,
        prev.z + (p.z - prev.z) * alpha + off.z
      );
      const q = predictor.rotation;
      me.ball.quaternion.set(q.x, q.y, q.z, q.w);
    }
    for (const view of playerViews.values()) {
      view.label.visible = view.ball.visible;
      view.label.position.set(view.ball.position.x, view.ball.position.y + 1.1, view.ball.position.z);
    }
    if (me?.ball.visible) {
      const target = me.ball.position;
      camera.position.lerp(new THREE.Vector3(target.x, target.y + 14, target.z + 13), 1 - Math.exp(-dt * 4));
      camera.lookAt(target.x, target.y, target.z);
    }

    hudStatus.textContent =
      `${serverUrl} · ${playerViews.size} player${playerViews.size === 1 ? "" : "s"} · ` +
      `input round trip ${Math.round(inputRttMs)} ms · prediction ${predictionOn ? "ON" : "OFF"}`;
  }

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// --- Start-up ----------------------------------------------------------------------------------

function localStorageGet(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
function localStorageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: nothing to remember */
  }
}

const params = new URLSearchParams(location.search);
nameInput.value = params.get("name") ?? localStorageGet("name");
serverInput.value = params.get("server") ?? (["localhost", "127.0.0.1"].includes(location.hostname) ? "localhost:7777" : "");
if (params.get("server")) void start(serverInput.value, nameInput.value);

// Hook for automated tests and the GIF recorder.
Object.assign(window, { __game: { keys, get connected() { return conn !== null; }, get players() { return playerViews.size; }, get position() { return predictor?.position ?? null; } } });
