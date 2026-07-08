// app.js - navegacion, telemetria y render de modulos
import { api, connectTelemetry } from "./api.js";
import { initBlocks, setBlocklyTheme } from "./blocks.js";

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

/* ---------------- LIDAR (radar 2D en vivo) ---------------- */
let _lidarWS = null;
function mountLidar() {
  const cv = document.getElementById("lidarCanvas");
  if (!cv) return;
  const ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height, cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 12;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

  window.__lidarCapture = async () => {
    const snap = await api.lidarCapture();
    alert(`Captura: ${snap.object_count ?? 0} objetos` + (snap.saved ? `\nGuardada en ${snap.saved}` : ""));
  };

  function draw(d) {
    const MAX = d.max_range || 12000;
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(45,212,238,.22)"; ctx.fillStyle = "rgba(45,212,238,.55)"; ctx.font = "10px monospace";
    for (let m = 3; m <= 12; m += 3) {
      const r = R * (m * 1000) / MAX;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.stroke();
      ctx.fillText(m + "m", cx + 3, cy - r + 12);
    }
    ctx.beginPath(); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.stroke();
    ctx.fillStyle = "#2dd4ee"; ctx.beginPath(); ctx.arc(cx, cy, 5, 0, 2 * Math.PI); ctx.fill();     // robot
    ctx.fillStyle = "rgba(230,240,255,.5)";
    for (const p of d.points || []) {
      const a = p.angle * Math.PI / 180, r = R * p.dist / MAX;
      ctx.fillRect(cx + r * Math.sin(a), cy - r * Math.cos(a), 2, 2);
    }
    const objs = (d.objects || []).slice().sort((a, b) => a.dist - b.dist);
    ctx.strokeStyle = "#ff7a45"; ctx.fillStyle = "#ff7a45"; ctx.lineWidth = 2;
    for (const o of objs) {
      const a = o.angle * Math.PI / 180, r = R * o.dist / MAX;
      const x = cx + r * Math.sin(a), y = cy - r * Math.cos(a);
      ctx.beginPath(); ctx.arc(x, y, 6, 0, 2 * Math.PI); ctx.stroke();
      ctx.fillText((o.dist / 1000).toFixed(2) + "m", x + 8, y + 3);
    }
    ctx.lineWidth = 1;
    set("l-count", objs.length);
    set("l-near", objs.length ? (objs[0].dist / 1000).toFixed(2) + " m" : "—");
    const fast = objs.reduce((m, o) => Math.abs(o.speed) > Math.abs(m) ? o.speed : m, 0);
    set("l-speed", objs.length ? fast.toFixed(2) + " m/s" : "—");
    const list = document.getElementById("l-list");
    if (list) list.innerHTML = objs.slice(0, 6).map(o =>
      `∡${o.angle}° · ${(o.dist / 1000).toFixed(2)}m · ⌀${o.size}mm · ${o.speed > 0 ? "+" : ""}${o.speed}m/s`).join("<br>") || "sin objetos";
    if (!d.available) { ctx.fillStyle = "rgba(255,120,120,.85)"; ctx.font = "13px monospace";
      ctx.fillText("LIDAR sin señal — revisa LIDAR_PORT", 18, H - 16); }
  }

  if (_lidarWS) { try { _lidarWS.close(); } catch {} }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  _lidarWS = new WebSocket(`${proto}://${location.host}/ws/lidar`);
  _lidarWS.onmessage = (ev) => { try { draw(JSON.parse(ev.data)); } catch {} };
}

/* ---------------- Geometría IK (plano fémur–tibia, interactivo) ---------------- */
function mountIK() {
  const cv = document.getElementById("ikCanvas");
  if (!cv) return;
  const ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height, F = 100, T = 115, SCALE = 1.5;   // mm y px/mm
  const hip = { x: W / 2, y: 80 };
  let foot = { x: hip.x + 30, y: 305 };
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const seg = (a, b, c, w) => { ctx.strokeStyle = c; ctx.lineWidth = w; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); };
  const dot = (p, c, r = 5) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 2 * Math.PI); ctx.fill(); };

  function drawFrame() {
    const dx = (foot.x - hip.x) / SCALE, dy = (foot.y - hip.y) / SCALE, h = Math.hypot(dx, dy);
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(255,255,255,.1)"; ctx.beginPath(); ctx.moveTo(hip.x, 0); ctx.lineTo(hip.x, H); ctx.stroke();
    const st = document.getElementById("ik-state");
    let knee = null;
    if (h <= F + T && h >= Math.abs(F - T)) {
      const angHF = Math.atan2(dx, dy);                                // 0 = hacia abajo
      const a = Math.acos((h * h + F * F - T * T) / (2 * h * F));
      const femurDir = angHF - a;
      knee = { x: hip.x + Math.sin(femurDir) * F * SCALE, y: hip.y + Math.cos(femurDir) * F * SCALE };
      const kneeAng = Math.acos((F * F + T * T - h * h) / (2 * F * T));
      seg(hip, knee, "#2dd4ee", 6); seg(knee, foot, "#7c8cff", 6);
      set("ik-femur", (femurDir * 180 / Math.PI).toFixed(0) + "°");
      set("ik-tibia", (kneeAng * 180 / Math.PI).toFixed(0) + "°");
      set("ik-state", "✓ alcanzable"); if (st) st.style.color = "#39d98a";
    } else {
      seg(hip, foot, "rgba(255,90,90,.35)", 2);
      set("ik-femur", "—"); set("ik-tibia", "—");
      set("ik-state", h > F + T ? "✗ muy lejos → NaN" : "✗ muy cerca → NaN"); if (st) st.style.color = "#ff5a5a";
    }
    set("ik-h", h.toFixed(0) + " mm");
    dot(hip, "#fff"); if (knee) dot(knee, "#fff"); dot(foot, "#ff7a45", 7);
  }

  const pos = (e) => { const r = cv.getBoundingClientRect(), t = e.touches ? e.touches[0] : e;
    return { x: (t.clientX - r.left) * cv.width / r.width, y: (t.clientY - r.top) * cv.height / r.height }; };
  let drag = false;
  const down = (e) => { drag = true; foot = pos(e); drawFrame(); e.preventDefault(); };
  const move = (e) => { if (drag) { foot = pos(e); drawFrame(); e.preventDefault(); } };
  cv.addEventListener("mousedown", down); cv.addEventListener("mousemove", move);
  window.addEventListener("mouseup", () => { drag = false; });
  cv.addEventListener("touchstart", down, { passive: false }); cv.addEventListener("touchmove", move, { passive: false });
  window.addEventListener("touchend", () => { drag = false; });
  drawFrame();
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
    <button class="btn eis-btn" style="margin-top:8px;width:100%" title="Estabilización digital de imagen (EIS)"
            onclick="window.__api.stabilize().then(r=>{this.textContent='🎥 Estabilizar: '+(r.stabilize?'ON':'OFF');this.classList.toggle('accent',!!r.stabilize)})">
      🎥 Estabilizar: OFF
    </button>
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
  "sec-lidar": () => head("Radar LIDAR", "RPLIDAR C1 · 360° · alcance 12 m") + `
    <div class="panels">
      <div class="panel tall"><h3>Radar en vivo</h3>
        <canvas id="lidarCanvas" width="520" height="520"
          style="width:100%;max-width:520px;aspect-ratio:1;background:#0a0e14;border-radius:12px;display:block;margin:0 auto"></canvas>
        <div class="btn-row" style="margin-top:12px">
          <button class="btn accent" onclick="window.__lidarCapture && window.__lidarCapture()">📸 Captura</button>
        </div>
      </div>
      <div class="panel"><h3>Objetos detectados</h3>
        <div class="metric"><span class="k">Más cercano</span><span class="v" id="l-near">—</span></div>
        <div class="metric"><span class="k">Objetos</span><span class="v" id="l-count">—</span></div>
        <div class="metric"><span class="k">Vel. máx (radial)</span><span class="v" id="l-speed">—</span></div>
        <div id="l-list" style="margin-top:10px;font-family:var(--mono);font-size:12px;opacity:.85">esperando escaneo…</div>
      </div>
    </div>`,
  "sec-ik": () => head("Geometría de las patas", "IK interactivo: arrastra el pie y observa los ángulos") + `
    <div class="panels">
      <div class="panel tall"><h3>Plano fémur–tibia</h3>
        <canvas id="ikCanvas" width="520" height="420"
          style="width:100%;max-width:520px;background:#0a0e14;border-radius:12px;display:block;margin:0 auto;cursor:crosshair;touch-action:none"></canvas>
        <p style="opacity:.7;font-size:13px;margin-top:8px">Arrastra el punto naranja (el pie). El IK resuelve los ángulos con <b>ley de cosenos</b>, igual que el firmware del robot.</p>
      </div>
      <div class="panel"><h3>Ángulos calculados</h3>
        <div class="metric"><span class="k">Fémur (desde vertical)</span><span class="v" id="ik-femur">—</span></div>
        <div class="metric"><span class="k">Rodilla (fémur–tibia)</span><span class="v" id="ik-tibia">—</span></div>
        <div class="metric"><span class="k">Alcance (h)</span><span class="v" id="ik-h">—</span></div>
        <div class="metric"><span class="k">Estado</span><span class="v" id="ik-state">—</span></div>
        <p style="opacity:.7;font-size:12px;margin-top:10px">Fémur 100 mm · Tibia 115 mm. Fuera del rango [15, 215] mm no hay solución → ese es el <b>NaN</b> que veías en el robot real.</p>
      </div>
    </div>`,

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
  if (_lidarWS) { try { _lidarWS.close(); } catch {} _lidarWS = null; }  // cierra el WS del LIDAR al salir de la vista
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
  if (view === "sec-lidar") setTimeout(mountLidar, 0);
  if (view === "sec-ik") setTimeout(mountIK, 0);
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

/* ---------------- tema claro / oscuro ---------------- */
function applyTheme(theme) {
  const light = theme === "light";
  document.body.classList.toggle("light", light);
  const t = document.getElementById("themeToggle");
  if (t) t.textContent = light ? "☀️" : "🌙";
  localStorage.setItem("neo-theme", theme);
  setBlocklyTheme(light);
}
const themeBtn = document.getElementById("themeToggle");
if (themeBtn) themeBtn.onclick = () =>
  applyTheme(document.body.classList.contains("light") ? "dark" : "light");
applyTheme(localStorage.getItem("neo-theme") || "dark");  // recuerda la preferencia

render("dashboard");
