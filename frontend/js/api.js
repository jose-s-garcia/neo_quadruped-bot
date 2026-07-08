// api.js - cliente de la API del robot (FastAPI backend)

const post = (path) => fetch(path, { method: "POST" }).then(r => r.json()).catch(() => ({}));

export const api = {
  stand:  ()        => post("/api/stand"),
  walk:   ()        => post("/api/walk"),
  gait:   ()        => post("/api/gait"),
  move:   (dir)     => post(`/api/move/${dir}`),
  stop:   ()        => post("/api/stop"),
  raw:    (key)     => post(`/api/raw/${encodeURIComponent(key)}`),
  stabilize: ()     => post("/api/camera/stabilize"),
  flip: ()          => post("/api/camera/flip"),
  snapshot: ()      => post("/api/camera/snapshot"),
  lidarCapture: ()  => post("/api/lidar/capture"),
  lidarStatus: ()   => fetch("/api/lidar/status").then(r => r.json()).catch(() => ({})),
  vision: (layer)   => post(`/api/vision/${layer}`),          // layer: "color" | "objects"
  visionFilter: (f) => post(`/api/vision/filter/${f}`),
  visionStatus: ()  => fetch("/api/vision/status").then(r => r.json()).catch(() => ({})),
  probe: (x, y)     => fetch(`/api/vision/probe?x=${x}&y=${y}`).then(r => r.json()).catch(() => ({ ok: false })),
  state:  ()        => fetch("/api/state").then(r => r.json()).catch(() => ({})),
};

// WebSocket de telemetria en vivo -> callback(state)
export function connectTelemetry(onUpdate) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/telemetry`);
  ws.onmessage = (ev) => { try { onUpdate(JSON.parse(ev.data)); } catch {} };
  ws.onclose = () => setTimeout(() => connectTelemetry(onUpdate), 2000); // reconectar
  return ws;
}
