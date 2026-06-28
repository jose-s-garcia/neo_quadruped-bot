// app.js - navegacion, telemetria y render de modulos
import { api, connectTelemetry } from "./api.js";

/* ---------------- helpers de control reutilizables ---------------- */
function holdButton(el, dir) {
  let iv = null;
  const start = (e) => { e.preventDefault(); api.move(dir); iv = setInterval(() => api.move(dir), 100); };
  const end = () => { clearInterval(iv); iv = null; };
  el.addEventListener("mousedown", start);
  el.addEventListener("touchstart", start, { passive: false });
  ["mouseup", "mouseleave", "touchend"].forEach(ev => el.addEventListener(ev, end));
}

function mountControlPad(root) {
  root.querySelectorAll("[data-dir]").forEach(b => holdButton(b, b.dataset.dir));
  // teclado WASD
  const keys = {};
  const map = { w: "forward", s: "back", a: "left", d: "right" };
  document.onkeydown = (e) => {
    if (map[e.key] && !keys[e.key]) { keys[e.key] = setInterval(() => api.move(map[e.key]), 100); api.move(map[e.key]); }
    if (e.key === " ") api.stand();
  };
  document.onkeyup = (e) => { if (keys[e.key]) { clearInterval(keys[e.key]); delete keys[e.key]; } };
}

function mountJoystick(zone) {
  let vec = { x: 0, y: 0 }, iv = null;
  const joy = nipplejs.create({ zone, mode: "static", position: { left: "50%", top: "50%" },
    color: "#2dd4ee", size: 130 });
  joy.on("move", (e, d) => { if (d.vector) vec = d.vector; });
  joy.on("start", () => {
    iv = setInterval(() => {
      if (vec.y > 0.3) api.move("forward");
      if (vec.y < -0.3) api.move("back");
      if (vec.x > 0.3) api.move("right");
      if (vec.x < -0.3) api.move("left");
    }, 100);
  });
  joy.on("end", () => { clearInterval(iv); iv = null; vec = { x: 0, y: 0 }; api.stop(); });
}

/* ---------------- bloques de UI ---------------- */
const head = (t, s) => `<div class="view-head"><h1>${t}</h1><p>${s}</p></div>`;

const controlBar = `
  <div class="btn-row" style="margin-bottom:16px">
    <button class="btn accent" onclick="window.__api.stand()">Pararse</button>
    <button class="btn" id="walkBtn">Caminar</button>
    <button class="btn" onclick="window.__api.gait()">Cambiar gait</button>
    <button class="btn warn" onclick="window.__api.stop()">STOP</button>
  </div>`;

const dpad = `
  <div class="dpad">
    <div class="empty"></div><button class="btn" data-dir="forward">▲</button><div class="empty"></div>
    <button class="btn" data-dir="left">◀</button><div class="empty"></div><button class="btn" data-dir="right">▶</button>
    <div class="empty"></div><button class="btn" data-dir="back">▼</button><div class="empty"></div>
  </div>`;

const placeholder = (title, desc, tag) =>
  `<div class="placeholder"><b>${title}</b>${desc}<div class="tag">${tag}</div></div>`;

/* ---------------- vistas / modulos ---------------- */
const views = {
  dashboard: () => head("Dashboard", "Control y telemetria en tiempo real") + `
    <div class="panels">
      <div class="panel tall"><h3>Control</h3>${controlBar}${dpad}
        <div id="joyzone" style="display:none"></div></div>
      <div class="panel"><h3>Telemetria</h3>
        <div class="metric"><span class="k">Conexion</span><span class="v" id="m-conn">—</span></div>
        <div class="metric"><span class="k">Stand</span><span class="v" id="m-stand">—</span></div>
        <div class="metric"><span class="k">Walk</span><span class="v" id="m-walk">—</span></div>
        <div class="metric"><span class="k">Pitch</span><span class="v" id="m-pitch">—</span></div>
        <div class="metric"><span class="k">Roll</span><span class="v" id="m-roll">—</span></div>
      </div>
      <div class="panel"><h3>Cámara</h3>${placeholder("Stream IMX477", "Video en vivo del robot.", "pendiente: driver Arducam")}</div>
    </div>`,

  "inicial-drive": () => head("Maneja al robot", "Conduce y observa lo que ve") + `
    <div class="panels"><div class="panel tall"><h3>Conducir</h3>${controlBar}${dpad}<div id="joyzone" style="display:none"></div></div>
      <div class="panel"><h3>Cámara</h3>${placeholder("¿Qué ve el robot?", "Vista en vivo.", "cámara")}</div></div>`,
  "inicial-blocks": () => head("Bloques", "Programa al robot arrastrando bloques") +
    placeholder("Editor de bloques (Blockly)", "Adelante, girar, esperar, repetir → el robot ejecuta. Introduce secuencias y algoritmos de forma visual.", "Blockly · por construir"),
  "inicial-tricks": () => head("Trucos", "Animaciones divertidas") + `
    <div class="panel"><div class="btn-row">
      <button class="btn" onclick="window.__api.raw('w')">Saludar</button>
      <button class="btn" onclick="window.__api.raw('2')">Cambiar caminata</button>
    </div></div>`,

  "sec-blocks": () => head("Bloques + sensores", "Bucles, condicionales y LIDAR") +
    placeholder("Blockly avanzado", "Bloques con repetir/si-entonces y bloques de sensor (si obstáculo &lt; X → girar). Conecta lógica con el LIDAR.", "Blockly + LIDAR"),
  "sec-lidar": () => head("Radar LIDAR", "Distancias y obstáculos en 2D") +
    placeholder("Radar 2D (RPLIDAR C1)", "Visualización en vivo del escaneo del LIDAR sobre un canvas tipo radar.", "LIDAR · WebSocket"),
  "sec-ik": () => head("Geometría de las patas", "Ángulos del IK en vivo (trigonometría)") +
    placeholder("Diagrama IK", "Ángulos coxa/fémur/tibia en tiempo real sobre un esquema de la pata. Enseña triángulos y trigonometría con el robot real.", "telemetría de ángulos"),

  "sup-vision": () => head("Visión por computador", "OpenCV sobre la cámara") +
    placeholder("Detección / seguimiento", "Tracking de color y detección de objetos; el robot sigue lo que ve.", "OpenCV · cámara"),
  "sup-slam": () => head("Mapeo SLAM", "Construye un mapa del entorno") +
    placeholder("Mapa 2D + navegación", "SLAM con el LIDAR: construye un mapa y navega evitando obstáculos.", "LIDAR · avanzado"),
  "sup-api": () => head("API de programación", "Controla el robot por código") + `
    <div class="panel"><h3>Endpoints</h3>
      <div class="placeholder" style="text-align:left;font-family:var(--mono);font-size:12px">
        POST /api/stand · /api/walk · /api/gait<br>POST /api/move/{forward|back|left|right}<br>
        POST /api/stop · /api/raw/{key}<br>GET&nbsp; /api/state · WS /ws/telemetry
        <div class="tag">Docs interactivas en /docs</div>
      </div></div>`,
};

/* ---------------- router ---------------- */
function render(view) {
  const root = document.getElementById("view");
  root.innerHTML = (views[view] || views.dashboard)();
  // montar interacciones segun lo que exista en la vista
  if (root.querySelector("[data-dir]")) mountControlPad(root);
  const jz = root.querySelector("#joyzone");
  if (jz && window.innerWidth <= 760) { jz.style.display = "block"; mountJoystick(jz); }
  const wb = root.querySelector("#walkBtn");
  if (wb) wb.onclick = async () => {
    const r = await api.walk();
    wb.textContent = r.walking ? "Detener" : "Caminar";
    wb.classList.toggle("accent", r.walking);
  };
}

document.querySelectorAll(".nav-item").forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll(".nav-item").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    render(btn.dataset.view);
  };
});

/* ---------------- telemetria global ---------------- */
window.__api = api;  // para los onclick inline
connectTelemetry((st) => {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  // barra superior
  const chip = document.getElementById("connChip");
  chip.classList.toggle("live", !!st.connected);
  document.getElementById("connText").textContent = st.connected ? "en línea" : "sin robot";
  document.getElementById("modeText").textContent = st.walking ? "CAMINAR" : st.stand ? "STAND" : "IDLE";
  // metricas del dashboard
  set("m-conn", st.connected ? "OK" : "—");
  set("m-stand", st.stand ? "ON" : "OFF");
  set("m-walk", st.walking ? "ON" : "OFF");
  set("m-pitch", st.pitch);
  set("m-roll", st.roll);
});

render("dashboard");
