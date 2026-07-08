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
