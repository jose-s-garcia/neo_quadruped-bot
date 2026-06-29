// app.js - navegacion, telemetria y render de modulos
import { api, connectTelemetry } from "./api.js";
import { initBlocks } from "./blocks.js";

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

// stream de camara en vivo (MJPEG) con fallback si no hay senal
const cameraView = `
  <div class="cam">
    <img src="/api/camera" alt="camara en vivo"
         onerror="this.style.display='none';this.nextElementSibling.style.display='block'">
    <div style="display:none">${placeholder("Cámara sin señal", "Inicia el server en el Jetson con la cámara conectada.", "IMX477")}</div>
  </div>`;

// avatar minimalista de NEO (perro robot) que reacciona a las acciones
const dogSvg = `
  <svg viewBox="0 0 220 150" class="dog-svg" xmlns="http://www.w3.org/2000/svg">
    <line class="ground" x1="15" y1="128" x2="205" y2="128"/>
    <g class="legs">
      <line class="leg lr" x1="70" y1="82" x2="70" y2="124"/>
      <line class="leg rr" x1="58" y1="82" x2="58" y2="124"/>
      <line class="leg lf" x1="150" y1="82" x2="150" y2="124"/>
      <line class="leg rf" x1="138" y1="82" x2="138" y2="124"/>
    </g>
    <line class="tail" x1="52" y1="56" x2="28" y2="44"/>
    <rect class="body" x="52" y="48" width="104" height="36" rx="16"/>
    <rect class="head" x="140" y="34" width="46" height="36" rx="14"/>
    <line class="ear" x1="152" y1="34" x2="148" y2="17"/>
    <circle class="ear-tip" cx="148" cy="16" r="3"/>
    <circle class="eye" cx="170" cy="50" r="5"/>
  </svg>`;

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
      <div class="panel"><h3>Cámara</h3>${cameraView}</div>
    </div>`,

  "inicial-drive": () => head("Maneja al robot", "Conduce y observa lo que ve") + `
    <div class="panels"><div class="panel tall"><h3>Conducir</h3>${controlBar}${dpad}<div id="joyzone" style="display:none"></div></div>
      <div class="panel"><h3>Cámara</h3>${cameraView}</div></div>`,
  "inicial-blocks": () => head("Programa a NEO", "Arrastra bloques, encájalos y dale ▶ Ejecutar") + `
    <div class="blocks-layout">
      <div class="blocks-main">
        <div class="btn-row" style="margin-bottom:12px">
          <button class="btn accent" id="runBtn">▶ Ejecutar</button>
          <button class="btn warn" id="stopBtn">⏹ Detener</button>
        </div>
        <div id="blocklyDiv" class="blockly"></div>
      </div>
      <aside class="blocks-side">
        <div class="panel">
          <h3>NEO en vivo</h3>
          <div class="neo-avatar">
            <div id="neoDog" class="neo-dog idle">${dogSvg}</div>
            <div class="neo-status" id="neoStatus">Listo para programar</div>
          </div>
        </div>
      </aside>
    </div>`,
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
  if (view === "inicial-blocks") setTimeout(initBlocks, 0);  // Blockly tras render
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
