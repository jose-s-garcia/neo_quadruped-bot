// api.js - cliente de la API del robot (FastAPI backend)

const post = (path) => fetch(path, { method: "POST" }).then(r => r.json()).catch(() => ({}));

export const api = {
  stand:  ()        => post("/api/stand"),
  walk:   ()        => post("/api/walk"),
  gait:   ()        => post("/api/gait"),
  move:   (dir)     => post(`/api/move/${dir}`),
  stop:   ()        => post("/api/stop"),
  raw:    (key)     => post(`/api/raw?key=${encodeURIComponent(key)}`),   // query, no ruta (el '.' en la ruta se pierde)
  stabilize: ()     => post("/api/camera/stabilize"),
  flip: ()          => post("/api/camera/flip"),
  snapshot: ()      => post("/api/camera/snapshot"),
  lidarCapture: ()  => post("/api/lidar/capture"),
  lidarStatus: ()   => fetch("/api/lidar/status").then(r => r.json()).catch(() => ({})),
  vision: (layer)   => post(`/api/vision/${layer}`),          // layer: "color" | "objects"
  visionFilter: (f) => post(`/api/vision/filter/${f}`),
  visionStatus: ()  => fetch("/api/vision/status").then(r => r.json()).catch(() => ({})),
  probe: (x, y)     => fetch(`/api/vision/probe?x=${x}&y=${y}`).then(r => r.json()).catch(() => ({ ok: false })),
  say: (text)       => post(`/api/say?text=${encodeURIComponent(text)}`),   // el robot habla
  bark: ()          => post("/api/bark"),                                   // ladrido por el altavoz del robot
  voiceStatus: ()   => fetch("/api/voice/status").then(r => r.json()).catch(() => ({})),
  follow: ()        => post("/api/vision/follow"),                          // seguir a la persona
  narrate: ()       => post("/api/narrate"),                               // narrar lo que ve
  cycleTarget: ()   => post("/api/vision/target/cycle"),
  targetAt: (x, y)  => post(`/api/vision/target?x=${x}&y=${y}`),
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
