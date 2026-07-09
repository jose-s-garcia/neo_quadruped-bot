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
    color: "#8cc63f", size: 130 });
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

/* ---------------- truco: ladrido / gruñido (suena en el dispositivo) ---------------- */
let _barkAudio = null;
window.__bark = () => {
  try {
    if (!_barkAudio) { _barkAudio = new Audio("assets/bark.mp3"); _barkAudio.preload = "auto"; }
    _barkAudio.currentTime = 0;
    _barkAudio.play().catch(() => {});   // algunos navegadores exigen gesto del usuario (el click lo es)
  } catch {}
  document.body.classList.add("barking");            // pulso rojo breve (perro enojado)
  clearTimeout(window.__barkT);
  window.__barkT = setTimeout(() => document.body.classList.remove("barking"), 700);
};

/* ---------------- voz: NEO habla (TTS en el Jetson) ---------------- */
window.__sayText = async (t) => {
  const r = await api.say(t);
  if (r && r.available === false) {
    const h = document.getElementById("voiceHint");
    if (h) h.textContent = "TTS no instalado en el Jetson: sudo apt install espeak-ng";
  }
};
window.__say = () => {
  const i = document.getElementById("sayInput");
  if (i && i.value.trim()) { window.__sayText(i.value.trim()); i.value = ""; i.focus(); }
};

/* ---------------- LIDAR: radar + info + marcadores + retos ---------------- */
let _lidarWS = null, _lidarLast = {}, _lidarMAX = 4000, _retosDone = {};
let _lidarMarkers = [];
try { _lidarMarkers = JSON.parse(localStorage.getItem("neo-lidar-markers") || "[]"); } catch {}
const _saveMarkers = () => localStorage.setItem("neo-lidar-markers", JSON.stringify(_lidarMarkers));
const NICE = [1000, 1500, 2000, 3000, 4000, 6000, 8000, 12000];

function drawRadar(d) {
  const cv = document.getElementById("lidarCanvas"); if (!cv) return;
  const ctx = cv.getContext("2d"), W = cv.width, H = cv.height, cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 16;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  // auto-escala: enfoca donde esta el ~90% de los puntos, pero los objetos SIEMPRE caben
  const ds = (d.points || []).map(p => p.dist).filter(x => x > 0).sort((a, b) => a - b);
  const p90 = ds.length ? ds[Math.floor(ds.length * 0.9)] : 2000;
  const maxObj = (d.objects || []).reduce((m, o) => Math.max(m, o.dist), 0);
  const MAX = NICE.find(n => n >= Math.max(p90, maxObj) * 1.12) || 12000; _lidarMAX = MAX;
  const P2 = (ang, dist) => { const a = ang * Math.PI / 180, r = Math.min(R * dist / MAX, R); return [cx + r * Math.sin(a), cy - r * Math.cos(a)]; };
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(140,198,63,.18)"; ctx.fillStyle = "rgba(140,198,63,.5)"; ctx.font = "10px monospace";
  for (let k = 1; k <= 4; k++) { const r = R * k / 4; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.stroke();
    ctx.fillText((MAX / 1000 * k / 4).toFixed(1) + "m", cx + 3, cy - r + 12); }
  ctx.strokeStyle = "rgba(140,198,63,.14)"; ctx.beginPath(); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.stroke();
  ctx.fillStyle = "rgba(160,190,230,.55)"; ctx.font = "11px system-ui";
  ctx.fillText("frente 0°", cx + 6, cy - R + 12); ctx.fillText("atrás", cx + 6, cy + R - 4);
  ctx.fillText("der →", cx + R - 34, cy - 6); ctx.fillText("← izq", cx - R + 4, cy - 6);
  // puntos coloreados por distancia (rojo=cerca, azul=lejos)
  for (const p of d.points || []) { if (p.dist > MAX) continue; const [x, y] = P2(p.angle, p.dist);
    ctx.fillStyle = `hsl(${Math.round(200 * p.dist / MAX)},85%,62%)`; ctx.fillRect(x, y, 2, 2); }
  ctx.fillStyle = "#8cc63f"; ctx.beginPath(); ctx.arc(cx, cy, 5, 0, 2 * Math.PI); ctx.fill();   // robot
  const objs = (d.objects || []).slice().sort((a, b) => a.dist - b.dist);
  ctx.lineCap = "round";
  for (const o of objs) {   // cada objeto: su extension (cuerda) + distancia
    const [x0, y0] = P2(o.a0, o.d0), [x1, y1] = P2(o.a1, o.d1);
    ctx.strokeStyle = "#ff7a45"; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    const [x, y] = P2(o.angle, o.dist); ctx.fillStyle = "#ffb08a"; ctx.font = "11px monospace"; ctx.fillText((o.dist / 1000).toFixed(2) + "m", x + 7, y + 3);
  }
  ctx.lineWidth = 1; ctx.lineCap = "butt";
  for (const m of _lidarMarkers) {   // marcadores del usuario (rombo + etiqueta)
    const [x, y] = P2(m.angle, m.dist);
    ctx.fillStyle = "#ffd54a"; ctx.beginPath(); ctx.moveTo(x, y - 6); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 6); ctx.lineTo(x - 6, y); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#ffe9a3"; ctx.font = "11px system-ui"; ctx.fillText(m.label, x + 9, y + 4);
  }
  set("l-count", objs.length);
  set("l-near", objs.length ? (objs[0].dist / 1000).toFixed(2) + " m" : "—");
  const fast = objs.reduce((m, o) => Math.abs(o.speed) > Math.abs(m) ? o.speed : m, 0);
  set("l-speed", objs.length ? fast.toFixed(2) + " m/s" : "—");
  set("l-hz", d.scan_hz ? d.scan_hz + " Hz" : "—"); set("l-pts", d.points_per_scan || "—");
  const inf = d.info || {}, he = d.health || {};
  set("l-model", inf.modelo || "—"); set("l-fw", inf.firmware || "—"); set("l-health", he.estado || "—");
  const list = document.getElementById("l-list");
  if (list) list.innerHTML = objs.slice(0, 7).map(o =>
    `∡${o.angle}° · ${(o.dist / 1000).toFixed(2)}m · ⌀${o.size}mm · ${o.speed > 0 ? "+" : ""}${o.speed}m/s`).join("<br>") || "sin objetos";
  if (!d.available) { ctx.fillStyle = "rgba(255,120,120,.85)"; ctx.font = "13px monospace"; ctx.fillText("LIDAR sin señal — revisa LIDAR_PORT", 18, H - 16); }
}

function renderMarkers() {
  const box = document.getElementById("l-markers"); if (!box) return;
  box.innerHTML = _lidarMarkers.length ? _lidarMarkers.map((m, i) =>
    `<div style="display:flex;justify-content:space-between;gap:8px;padding:3px 0;align-items:center">
       <span>◆ ${m.label} <span style="opacity:.6">${(m.dist / 1000).toFixed(2)}m ∡${m.angle}°</span></span>
       <button class="btn" style="padding:2px 8px;font-size:11px" onclick="window.__lidarDelMarker(${i})">✕</button></div>`).join("")
    : `<span style="opacity:.6">Toca el radar para marcar un objeto encontrado. Los marcadores se guardan en este navegador.</span>`;
}
window.__lidarDelMarker = (i) => { _lidarMarkers.splice(i, 1); _saveMarkers(); renderMarkers(); if (_lidarLast.points) drawRadar(_lidarLast); };
window.__lidarClearMarkers = () => { if (confirm("¿Borrar todos los marcadores?")) { _lidarMarkers = []; _saveMarkers(); renderMarkers(); } };

function mountLidarRadar() {
  const cv = document.getElementById("lidarCanvas"); if (!cv) return;
  window.__lidarCapture = async () => { const s = await api.lidarCapture(); alert(`Captura: ${s.object_count ?? 0} objetos` + (s.saved ? `\nGuardada en ${s.saved}` : "")); };
  cv.onclick = (e) => {   // click/tap -> convierte a coordenadas polares y crea un marcador
    const r = cv.getBoundingClientRect();
    const x = (e.clientX - r.left) * cv.width / r.width - cv.width / 2;
    const y = (e.clientY - r.top) * cv.height / r.height - cv.height / 2;
    const R = Math.min(cv.width, cv.height) / 2 - 16, dist = Math.hypot(x, y) / R * _lidarMAX;
    let ang = Math.atan2(x, -y) * 180 / Math.PI; if (ang < 0) ang += 360;
    const def = "Objeto " + (_lidarMarkers.length + 1);
    const label = prompt("Nombre del marcador:", def); if (label === null) return;
    _lidarMarkers.push({ angle: +ang.toFixed(1), dist: Math.round(dist), label: label || def });
    _saveMarkers(); renderMarkers(); drawRadar(_lidarLast);
  };
  renderMarkers();
  drawRadar(_lidarLast);   // dibuja la rejilla aunque aún no haya datos ("sin señal")
}

const _RETOS = [
  { id: "cerca",  txt: "Coloca un objeto a menos de 50 cm",            ok: d => (d.objects || []).some(o => o.dist < 500) },
  { id: "tres",   txt: "Detecta 3 objetos a la vez",                   ok: d => (d.objects || []).length >= 3 },
  { id: "grande", txt: "Encuentra un objeto ancho (más de 30 cm)",     ok: d => (d.objects || []).some(o => o.size > 300) },
  { id: "mueve",  txt: "Haz que algo se acerque (velocidad negativa)", ok: d => (d.objects || []).some(o => o.speed < -0.3) },
  { id: "lejos",  txt: "Detecta algo a más de 3 metros",               ok: d => (d.objects || []).some(o => o.dist > 3000) },
];
function updateRetos(d) {
  const box = document.getElementById("l-retos"); if (!box) return;
  for (const r of _RETOS) if (!_retosDone[r.id] && r.ok(d)) _retosDone[r.id] = true;
  box.innerHTML = _RETOS.map(r => `<div class="metric"><span class="k">${_retosDone[r.id] ? "✅" : "⬜"} ${r.txt}</span><span class="v">${_retosDone[r.id] ? "¡logrado!" : "…"}</span></div>`).join("");
}
window.__retosReset = () => { _retosDone = {}; if (_lidarLast.points) updateRetos(_lidarLast); };

function mountLidar() {
  const tabs = document.getElementById("lidarTabs"), content = document.getElementById("lidarContent");
  if (!tabs) return;
  function show(tab) {
    tabs.querySelectorAll("button").forEach(b => b.classList.toggle("accent", b.dataset.ltab === tab));
    if (tab === "radar") { content.innerHTML = lidarRadarHTML(); mountLidarRadar(); }
    else if (tab === "aprende") { content.innerHTML = lidarLearnHTML(); }
    else { content.innerHTML = lidarRetosHTML(); updateRetos(_lidarLast); }   // muestra la lista aunque no haya datos aún
  }
  tabs.querySelectorAll("button").forEach(b => b.onclick = () => show(b.dataset.ltab));
  show("radar");
  if (_lidarWS) { try { _lidarWS.close(); } catch {} }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  _lidarWS = new WebSocket(`${proto}://${location.host}/ws/lidar`);
  _lidarWS.onmessage = (ev) => {
    try { _lidarLast = JSON.parse(ev.data); } catch { return; }
    if (document.getElementById("lidarCanvas")) drawRadar(_lidarLast);
    if (document.getElementById("l-retos")) updateRetos(_lidarLast);
  };
}

/* ---------------- Geometría IK: pestañas + solver compartido ---------------- */
let _ikRAF = null;
const IK_F = 100, IK_T = 115;   // mm (fémur, tibia)

function ikSolve(dx, dy) {   // dx fore-aft, dy hacia abajo (mm) -> {femurDir, kneeAng, h} o null
  const h = Math.hypot(dx, dy);
  if (h > IK_F + IK_T || h < Math.abs(IK_F - IK_T)) return null;
  const a = Math.acos((h * h + IK_F * IK_F - IK_T * IK_T) / (2 * h * IK_F));
  return { femurDir: Math.atan2(dx, dy) - a, kneeAng: Math.acos((IK_F * IK_F + IK_T * IK_T - h * h) / (2 * IK_F * IK_T)), h };
}

function mountIK() {
  const tabs = document.getElementById("ikTabs");
  if (!tabs) return;
  const content = document.getElementById("ikContent");
  function show(tab) {
    if (_ikRAF) { cancelAnimationFrame(_ikRAF); _ikRAF = null; }
    tabs.querySelectorAll("button").forEach(b => b.classList.toggle("accent", b.dataset.tab === tab));
    if (tab === "interactivo") { content.innerHTML = ikInteractiveHTML(); mountIKInteractive(); }
    else { const live = tab === "envivo"; content.innerHTML = gaitsHTML(live); mountGaits(live); }
  }
  tabs.querySelectorAll("button").forEach(b => b.onclick = () => show(b.dataset.tab));
  show("interactivo");
}

function ikInteractiveHTML() {
  return `
    <div class="panels">
      <div class="panel tall"><h3>Plano fémur–tibia</h3>
        <canvas id="ikCanvas" width="520" height="420" style="width:100%;max-width:520px;background:#0a0e14;border-radius:12px;display:block;margin:0 auto;cursor:crosshair;touch-action:none"></canvas>
        <p style="opacity:.7;font-size:13px;margin-top:8px">Arrastra el punto naranja (el pie). Ley de cosenos, igual que el firmware.</p></div>
      <div class="panel"><h3>Ángulos calculados</h3>
        <div class="metric"><span class="k">Fémur (desde vertical)</span><span class="v" id="ik-femur">—</span></div>
        <div class="metric"><span class="k">Rodilla (fémur–tibia)</span><span class="v" id="ik-tibia">—</span></div>
        <div class="metric"><span class="k">Alcance (h)</span><span class="v" id="ik-h">—</span></div>
        <div class="metric"><span class="k">Estado</span><span class="v" id="ik-state">—</span></div>
        <p style="opacity:.7;font-size:12px;margin-top:10px">Fuera de [15, 215] mm → sin solución (el <b>NaN</b> real).</p></div>
    </div>`;
}

/* Marchas del robot: 3 gaits x 4 vistas + diagrama de fase.
   Cada gait define el desfase de cada pata en el ciclo y el "duty" (fraccion del
   ciclo que la pata pasa APOYADA en el suelo). Con eso se ve por que unas marchas
   son mas rapidas y otras mas estables. */
const GAITS = {
  trote:    { name: "Trote", duty: 0.5,  phases: { FL: 0, FR: 0.5, BL: 0.5, BR: 0 },
              desc: "Patas en diagonal se mueven a la vez. Rápido y equilibrado — la marcha por defecto." },
  lateral:  { name: "Lateral (paso)", duty: 0.5, phases: { FL: 0, BL: 0, FR: 0.5, BR: 0.5 },
              desc: "Las dos patas del mismo lado a la vez. Se balancea de lado a lado." },
  diagonal: { name: "Reptar (4 tiempos)", duty: 0.75, phases: { FL: 0, BR: 0.25, FR: 0.5, BL: 0.75 },
              desc: "Una pata por vez; siempre hay 3 en el suelo. Lento pero el más estable." },
};
const LEGS = [
  { id: "FL", lx: 90,  ly: 60,  name: "Del. izq." },
  { id: "FR", lx: 90,  ly: -60, name: "Del. der." },
  { id: "BL", lx: -90, ly: 60,  name: "Tras. izq." },
  { id: "BR", lx: -90, ly: -60, name: "Tras. der." },
];
const IK_Z = 150, IK_STEP = 70, IK_LIFT = 38;   // altura de pie, largo de paso, alto de vuelo (mm)

function legPhase(G, id, phase) { let p = (phase + G.phases[id]) % 1; return p < 0 ? p + 1 : p; }
function footFrom(G, id, phase, mode) {          // -> {x fore-aft mm, lift mm}
  if (mode !== "walk") return { x: 0, lift: 0 };
  const p = legPhase(G, id, phase);
  if (p < G.duty) { const u = p / G.duty; return { x: IK_STEP * (0.5 - u), lift: 0 }; }   // apoyo: va hacia atras
  const u = (p - G.duty) / (1 - G.duty); return { x: IK_STEP * (u - 0.5), lift: IK_LIFT * Math.sin(Math.PI * u) }; // vuelo
}
const _seg = (ctx, ax, ay, bx, by, c, w) => { ctx.strokeStyle = c; ctx.lineWidth = w; ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); };
const _dot = (ctx, x, y, c, r) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fill(); };
const _cap = (ctx, txt) => { ctx.fillStyle = "rgba(140,198,63,.9)"; ctx.font = "12px system-ui"; ctx.fillText(txt, 14, 22); };

function drawSide(ctx, W, H, G, phase, mode) {   // perfil: IK completa (cadera-rodilla-pie)
  const sc = 1.0, cx = W / 2, hipY = 100;
  _seg(ctx, 40, hipY + IK_Z + 8, W - 40, hipY + IK_Z + 8, "rgba(255,255,255,.08)", 1);   // suelo
  _seg(ctx, cx - 90 * sc, hipY, cx + 90 * sc, hipY, "#8aa0c8", 16);                        // cuerpo
  for (const [id, faded] of [["FL", 1], ["BL", 1], ["FR", 0], ["BR", 0]]) {
    const leg = LEGS.find(l => l.id === id), hipx = cx + leg.lx * sc;
    const f = footFrom(G, id, phase, mode), sol = ikSolve(f.x, IK_Z - f.lift);
    if (!sol) continue;
    const kx = hipx + Math.sin(sol.femurDir) * IK_F * sc, ky = hipY + Math.cos(sol.femurDir) * IK_F * sc;
    const fx = hipx + f.x * sc, fy = hipY + (IK_Z - f.lift) * sc;
    _seg(ctx, hipx, hipY, kx, ky, faded ? "rgba(140,198,63,.25)" : "#8cc63f", 6);
    _seg(ctx, kx, ky, fx, fy, faded ? "rgba(124,140,255,.25)" : "#7c8cff", 6);
    _dot(ctx, hipx, hipY, "#fff", 3);
    _dot(ctx, fx, fy, f.lift > 1 ? "#ff7a45" : (faded ? "rgba(230,240,255,.4)" : "#e6f0ff"), 5);
  }
  _cap(ctx, "VISTA LATERAL (perfil) · → adelante · patas derechas resaltadas");
}
function drawTop(ctx, W, H, G, phase, mode) {    // superior: coordinacion de las 4 patas
  const sc = 1.4, cx = W / 2, cy = 165;
  const S = (x, y) => [cx - y * sc, cy - x * sc];
  ctx.fillStyle = "rgba(138,160,200,.15)"; ctx.strokeStyle = "#8aa0c8"; ctx.lineWidth = 2;
  ctx.beginPath(); [[90, 60], [90, -60], [-90, -60], [-90, 60]].forEach((p, i) => { const [x, y] = S(p[0], p[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath(); ctx.fill(); ctx.stroke();
  _seg(ctx, cx, cy - 12, cx, cy - 150, "rgba(140,198,63,.4)", 2); _dot(ctx, cx, cy - 150, "#8cc63f", 3);  // flecha adelante
  for (const leg of LEGS) {
    const f = footFrom(G, leg.id, phase, mode);
    const [hx, hy] = S(leg.lx, leg.ly), [sx, sy] = S(leg.lx + f.x, leg.ly), swing = f.lift > 1;
    _seg(ctx, hx, hy, sx, sy, "rgba(255,255,255,.15)", 2);
    _dot(ctx, sx, sy, swing ? "#ff7a45" : "#8cc63f", swing ? 5 + f.lift * 0.08 : 6);
    if (swing) { ctx.strokeStyle = "#ff7a45"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(sx, sy, 10, 0, 2 * Math.PI); ctx.stroke(); }
  }
  _cap(ctx, "VISTA SUPERIOR · azul = apoyo · naranja = vuelo (levantada)");
}
function drawFront(ctx, W, H, G, phase, mode) {  // frontal: par delantero, se ve el levante
  const sc = 1.5, cx = W / 2, hipY = 90;
  _seg(ctx, cx - 60 * sc, hipY, cx + 60 * sc, hipY, "#8aa0c8", 16);
  for (const id of ["FL", "FR"]) {
    const leg = LEGS.find(l => l.id === id), hipx = cx - leg.ly * sc, f = footFrom(G, id, phase, mode);
    const kx = hipx + (leg.ly > 0 ? -7 : 7), ky = hipY + IK_Z * 0.5 * sc, fy = hipY + (IK_Z - f.lift) * sc;
    _seg(ctx, hipx, hipY, kx, ky, "#8cc63f", 6); _seg(ctx, kx, ky, hipx, fy, "#7c8cff", 6);
    _dot(ctx, hipx, hipY, "#fff", 3); _dot(ctx, hipx, fy, f.lift > 1 ? "#ff7a45" : "#e6f0ff", 5);
  }
  _cap(ctx, "VISTA FRONTAL · patas delanteras");
}
function drawIso(ctx, W, H, G, phase, mode) {    // isometrica: pseudo-3D
  const sc = 1.0, cx = W / 2, cy = 140;
  const P = (x, y, z) => [cx + (x - y) * 0.6 * sc, cy - (x + y) * 0.3 * sc + z * 0.55 * sc];
  ctx.fillStyle = "rgba(138,160,200,.18)"; ctx.strokeStyle = "#8aa0c8"; ctx.lineWidth = 2;
  ctx.beginPath(); [[90, 60], [90, -60], [-90, -60], [-90, 60]].forEach((c, i) => { const [x, y] = P(c[0], c[1], 0); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath(); ctx.fill(); ctx.stroke();
  for (const leg of LEGS) {
    const f = footFrom(G, leg.id, phase, mode);
    const [hx, hy] = P(leg.lx, leg.ly, 0), [fx, fy] = P(leg.lx + f.x, leg.ly, IK_Z - f.lift);
    _seg(ctx, hx, hy, fx, fy, "#8cc63f", 5); _dot(ctx, hx, hy, "#fff", 3);
    _dot(ctx, fx, fy, f.lift > 1 ? "#ff7a45" : "#e6f0ff", 5);
  }
  _cap(ctx, "VISTA ISOMÉTRICA (3D)");
}
function drawPhaseDiagram(ctx, W, H, G, phase, mode) {
  const x0 = 78, x1 = W - 20, y0 = H - 92, rowH = 16, gap = 5, N = 120;
  ctx.fillStyle = "rgba(255,255,255,.7)"; ctx.font = "12px system-ui";
  ctx.fillText("Diagrama de fase — cuándo cada pata pisa (apoyo) o vuela", x0, y0 - 8);
  ["FL", "FR", "BL", "BR"].forEach((id, i) => {
    const y = y0 + i * (rowH + gap);
    ctx.fillStyle = "rgba(255,255,255,.55)"; ctx.font = "11px monospace";
    ctx.fillText(LEGS.find(l => l.id === id).name, 4, y + rowH - 3);
    ctx.fillStyle = "rgba(124,140,255,.15)"; ctx.fillRect(x0, y, x1 - x0, rowH);   // fondo = vuelo
    ctx.fillStyle = "rgba(140,198,63,.55)";                                        // barras = apoyo
    for (let k = 0; k < N; k++) {
      const t = k / N, p = (t + G.phases[id]) % 1;
      if (mode !== "walk" || p < G.duty) ctx.fillRect(x0 + t * (x1 - x0), y, (x1 - x0) / N + 1, rowH);
    }
  });
  const px = x0 + (mode === "walk" ? phase : 0) * (x1 - x0);   // cabezal
  ctx.strokeStyle = "#ff7a45"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(px, y0 - 2); ctx.lineTo(px, y0 + 4 * (rowH + gap)); ctx.stroke();
}

function gaitsHTML(live) {
  const gaitBtns = live ? "" : `<div class="btn-row" id="gaitSel" style="gap:6px;margin-bottom:8px;flex-wrap:wrap">
      <button class="btn accent" data-gait="trote">Trote</button>
      <button class="btn" data-gait="lateral">Lateral</button>
      <button class="btn" data-gait="diagonal">Reptar</button></div>`;
  return `
    <div class="panel">
      <h3>${live ? "Marcha del robot · en vivo" : "Marchas (gaits) del robot"}</h3>
      <p style="opacity:.7;font-size:13px;margin:-2px 0 10px">${live
        ? "Refleja stand / caminar del robot. El firmware aún no envía los ángulos reales, así que es una representación fiel del patrón de marcha."
        : "Elige una marcha y un punto de vista. El diagrama de abajo muestra la coordinación de las 4 patas."}</p>
      ${gaitBtns}
      <div class="btn-row" id="viewSel" style="gap:6px;margin-bottom:10px;flex-wrap:wrap">
        <button class="btn accent" data-view3d="side">Lateral</button>
        <button class="btn" data-view3d="top">Superior</button>
        <button class="btn" data-view3d="front">Frontal</button>
        <button class="btn" data-view3d="iso">Isométrica</button>
      </div>
      <canvas id="gaitCv" width="640" height="470" style="width:100%;max-width:640px;background:#0a0e14;border-radius:12px;display:block;margin:0 auto"></canvas>
      <div id="gaitInfo" style="opacity:.85;font-size:13px;margin-top:8px"></div>
    </div>`;
}

function mountGaits(live) {
  const cv = document.getElementById("gaitCv");
  if (!cv) return;
  const ctx = cv.getContext("2d"), W = cv.width, H = cv.height, info = document.getElementById("gaitInfo");
  let gait = "trote", view = "side", t0 = performance.now();
  const sel = (id, attr, set) => { const box = document.getElementById(id); if (box) box.querySelectorAll(`[data-${attr}]`).forEach(b => b.onclick = () => { set(b.dataset[attr]); box.querySelectorAll(`[data-${attr}]`).forEach(x => x.classList.toggle("accent", x === b)); }); };
  sel("gaitSel", "gait", v => { gait = v; t0 = performance.now(); });
  sel("viewSel", "view3d", v => view = v);

  function loop(now) {
    let mode = "walk";
    if (live) { const st = window.__lastState || {}; mode = st.walking ? "walk" : st.stand ? "stand" : "idle"; }
    const g = (now - t0) / 1000 * 0.75, phase = mode === "walk" ? (g % 1) : 0;
    const G = GAITS[live ? "trote" : gait];
    ctx.clearRect(0, 0, W, H);
    ({ side: drawSide, top: drawTop, front: drawFront, iso: drawIso }[view])(ctx, W, H, G, phase, mode);
    drawPhaseDiagram(ctx, W, H, G, phase, mode);
    if (info) info.innerHTML = live
      ? `<b>Modo:</b> ${mode.toUpperCase()} &nbsp;·&nbsp; patrón: Trote`
      : `<b>${G.name}.</b> ${G.desc} &nbsp;·&nbsp; <span style="opacity:.6">duty ${Math.round(G.duty * 100)}% (tiempo apoyada)</span>`;
    _ikRAF = requestAnimationFrame(loop);
  }
  _ikRAF = requestAnimationFrame(loop);
}

/* ---------------- Geometría IK: pestaña interactiva (una pata) ---------------- */
function mountIKInteractive() {
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
      seg(hip, knee, "#8cc63f", 6); seg(knee, foot, "#7c8cff", 6);
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

// modo desarrollador: fila de botones que envian teclas crudas (data-key evita lios de comillas)
const devKeys = (pairs) => `<div class="btn-row" style="flex-wrap:wrap;gap:8px">` +
  pairs.map(([label, key]) => `<button class="btn" data-key="${encodeURIComponent(key)}">${label}</button>`).join("") + `</div>`;

let _devWS = null;
function mountDev() {
  const view = document.getElementById("view");
  const con = document.getElementById("devConsole");
  if (!con) return;
  con.textContent = "";
  view.querySelectorAll("[data-key]").forEach(b => b.onclick = () => api.raw(decodeURIComponent(b.dataset.key)));
  window.__devRaw = () => { const i = document.getElementById("devRaw"); if (i && i.value) { api.raw(i.value); i.value = ""; i.focus(); } };
  const inp = document.getElementById("devRaw");
  if (inp) inp.onkeydown = (e) => { if (e.key === "Enter") window.__devRaw(); };
  if (_devWS) { try { _devWS.close(); } catch {} }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  _devWS = new WebSocket(`${proto}://${location.host}/ws/console`);
  _devWS.onopen = () => { con.textContent = "— consola conectada —\n"; };
  _devWS.onmessage = (ev) => {
    try {
      const { lines } = JSON.parse(ev.data);
      for (const l of lines) con.textContent += l + "\n";
      const arr = con.textContent.split("\n");
      if (arr.length > 400) con.textContent = arr.slice(-400).join("\n");
      con.scrollTop = con.scrollHeight;
    } catch {}
  };
}

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

/* ---------------- LIDAR: HTML de cada pestaña ---------------- */
function lidarRadarHTML() {
  return `
    <div class="panels">
      <div class="panel tall"><h3>Radar en vivo</h3>
        <canvas id="lidarCanvas" width="520" height="520" style="width:100%;max-width:520px;aspect-ratio:1;background:#0a0e14;border-radius:12px;display:block;margin:0 auto"></canvas>
        <div class="btn-row" style="margin-top:12px;gap:8px;flex-wrap:wrap">
          <button class="btn accent" onclick="window.__lidarCapture&&window.__lidarCapture()">📸 Captura</button>
          <button class="btn" onclick="window.__lidarClearMarkers&&window.__lidarClearMarkers()">🗑 Borrar marcadores</button>
        </div>
        <p style="opacity:.7;font-size:12px;margin-top:8px">Toca el radar para <b>marcar</b> un objeto encontrado. Color de los puntos: rojo = cerca, azul = lejos.</p>
      </div>
      <div class="panel"><h3>Sensor</h3>
        <div class="metric"><span class="k">Modelo</span><span class="v" id="l-model">—</span></div>
        <div class="metric"><span class="k">Firmware</span><span class="v" id="l-fw">—</span></div>
        <div class="metric"><span class="k">Salud</span><span class="v" id="l-health">—</span></div>
        <div class="metric"><span class="k">Escaneo real</span><span class="v" id="l-hz">—</span></div>
        <div class="metric"><span class="k">Puntos/vuelta</span><span class="v" id="l-pts">—</span></div>
        <h3 style="margin-top:14px">Objetos</h3>
        <div class="metric"><span class="k">Más cercano</span><span class="v" id="l-near">—</span></div>
        <div class="metric"><span class="k">Detectados</span><span class="v" id="l-count">—</span></div>
        <div class="metric"><span class="k">Vel. máx (radial)</span><span class="v" id="l-speed">—</span></div>
        <div id="l-list" style="margin-top:8px;font-family:var(--mono);font-size:12px;opacity:.85">esperando escaneo…</div>
        <h3 style="margin-top:14px">Marcadores</h3>
        <div id="l-markers" style="font-size:13px"></div>
      </div>
    </div>`;
}
function lidarLearnHTML() {
  return `
    <div class="panel" style="line-height:1.65">
      <h3>¿Qué es un LIDAR?</h3>
      <p><b>LIDAR</b> = <i>Light Detection And Ranging</i>. Dispara un rayo láser y mide a qué distancia está lo que golpea. El RPLIDAR&nbsp;C1 <b>gira el láser 360°</b> unas <b>10 veces por segundo</b>, tomando ~500 medidas por vuelta.</p>
      <h3>¿Cómo mide la distancia?</h3>
      <p>El C1 usa <b>triangulación</b>: mira <i>en qué ángulo</i> vuelve el reflejo dentro del sensor. Muy inclinado → objeto cerca; casi recto → lejos. (Otros LIDAR miden el <i>tiempo</i> que tarda la luz en volver, "time of flight".)</p>
      <h3>Coordenadas polares</h3>
      <p>Cada medida es un par <b>(ángulo, distancia)</b>. Para dibujarlo pasamos a X/Y: <code>x = d·sin(θ)</code>, <code>y = d·cos(θ)</code>. El robot está en el centro y 0° es el frente.</p>
      <h3>De puntos a objetos</h3>
      <p>Los puntos forman una <b>nube</b>. Agrupamos los que están juntos (ángulo y distancia parecidos) en <b>objetos</b>, y de cada grupo sacamos su <b>tamaño</b> y su <b>distancia</b>.</p>
      <h3>Velocidad</h3>
      <p>Comparando un objeto entre dos vueltas medimos cuánto cambió su distancia: la <b>velocidad radial</b>. Negativa = se acerca; positiva = se aleja.</p>
      <h3>¿Para qué sirve?</h3>
      <p>Para <b>evitar obstáculos</b>, <b>medir espacios</b> y, más adelante, hacer <b>SLAM</b> (mapear el entorno mientras el robot se ubica en él).</p>
      <div class="metric" style="margin-top:10px"><span class="k">Alcance</span><span class="v">12 m (blanco) / 6 m (negro)</span></div>
      <div class="metric"><span class="k">Resolución</span><span class="v">0.72° · ~500 puntos/vuelta</span></div>
      <div class="metric"><span class="k">Longitud de onda</span><span class="v">905 nm (infrarrojo)</span></div>
    </div>`;
}
function lidarRetosHTML() {
  return `
    <div class="panel">
      <h3>Retos con el LIDAR</h3>
      <p style="opacity:.75;font-size:13px;margin-bottom:10px">Mueve objetos frente al robot y observa cómo reacciona el radar. Cada reto se marca solo cuando lo logras.</p>
      <div id="l-retos"></div>
      <div class="btn-row" style="margin-top:12px"><button class="btn" onclick="window.__retosReset&&window.__retosReset()">↺ Reiniciar retos</button></div>
    </div>`;
}

/* ---------------- Visión: IA de objetos + colores + laboratorio ---------------- */
let _visionIV = null;
const V_FILTERS = [["normal", "Normal"], ["bordes", "Bordes"], ["contornos", "Contornos"],
                   ["gris", "Gris"], ["termica", "Térmica"], ["movimiento", "Movimiento"]];
function visionHTML() {
  return `
    <div class="panels">
      <div class="panel tall"><h3>Cámara inteligente</h3>
        <div class="cam">
          <img id="visCam" src="/api/camera" alt="camara con visión" style="cursor:crosshair" title="Toca el video para medir el color en ese punto"
               onerror="this.style.display='none';this.nextElementSibling.style.display='block'">
          <div style="display:none">${placeholder("Cámara sin señal", "Inicia el server en el Jetson con la cámara conectada.", "IMX477")}</div>
        </div>
        <div class="btn-row" style="margin-top:10px;gap:8px;flex-wrap:wrap">
          <button class="btn" id="vColorBtn">🎨 Colores: OFF</button>
          <button class="btn" id="vObjBtn">🧠 Objetos (IA): OFF</button>
          <button class="btn" id="vSnapBtn">📸 Foto</button>
          <button class="btn" id="vFlipBtn" title="Por si la imagen se ve al revés">🔃 Girar 180°</button>
        </div>
        <div class="btn-row" style="margin-top:8px;gap:8px;flex-wrap:wrap">
          <button class="btn" id="vFollowBtn">🎯 Seguir: OFF</button>
          <button class="btn" id="vCycleBtn">⏭ Cambiar objetivo</button>
          <button class="btn" id="vNarrateBtn">🗣 Narrar: OFF</button>
        </div>
        <p style="opacity:.6;font-size:11px;margin-top:8px">Con <b>Objetos</b> activo, <b>toca</b> a alguien en el video para seguirlo. <b>Seguir</b> mueve el robot — pruébalo con las patas al aire primero.</p>
        <div style="margin-top:10px;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted)">Laboratorio de filtros</div>
        <div class="btn-row" id="vFilters" style="margin-top:6px;gap:6px;flex-wrap:wrap">
          ${V_FILTERS.map(([f, label]) => `<button class="btn" style="padding:7px 12px;font-size:12px" data-vf="${f}">${label}</button>`).join("")}
        </div>
        <div id="vDnnWarn" style="display:none;margin-top:10px;font-size:12px;color:#fbbf24;line-height:1.5">
          ⚠ El modelo de IA no está instalado: "Objetos" solo verá personas (HOG, impreciso).
          Instálalo en 1 minuto — instrucciones en <code>backend/models/README.md</code>.
        </div>
      </div>
      <div class="panel"><h3>Detecciones en vivo</h3>
        <div class="metric"><span class="k">Objetos (IA)</span><span class="v" id="v-obj-count">0</span></div>
        <div class="metric"><span class="k">Colores</span><span class="v" id="v-col-count">0</span></div>
        <div id="v-dets" style="margin-top:8px;font-family:var(--mono);font-size:12.5px;line-height:1.9;opacity:.9">—</div>
        <h3 style="margin-top:16px">🔬 Cuentagotas</h3>
        <div id="v-probe" style="font-size:13px;opacity:.85;line-height:1.6">Toca cualquier punto del video y te digo su color con sus valores <b>HSV</b> — los mismos números que usa el detector de colores.</div>
      </div>
      <div class="panel" style="line-height:1.6;font-size:13.5px">
        <h3>Cómo funciona</h3>
        <p><b>🧠 Objetos (IA):</b> una red neuronal <b>YOLO</b> mira el cuadro completo UNA vez y predice qué hay y dónde: reconoce <b>80 clases</b> (persona, teléfono, botella, laptop, silla, perro…) — <b>varias a la vez</b>, cada una con su % de confianza.</p>
        <p><b>🎨 Colores:</b> convierte la imagen a <b>HSV</b>; el canal H (tono) identifica el color puro sin que lo confunda la luz. Solo marca colores <i>vivos</i> — usa el cuentagotas para entender por qué un objeto pálido no cuenta.</p>
        <p><b>🔬 Filtros:</b> <i>Bordes</i> = algoritmo de Canny (cambios bruscos de intensidad) · <i>Contornos</i> = siluetas cerradas · <i>Térmica</i> = brillo→mapa de calor (no mide temperatura real) · <i>Movimiento</i> = resta el cuadro anterior: solo lo que cambió se pinta verde.</p>
      </div>
    </div>`;
}
function mountVision() {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const cBtn = document.getElementById("vColorBtn"), oBtn = document.getElementById("vObjBtn");
  const fBtn = document.getElementById("vFollowBtn"), nBtn = document.getElementById("vNarrateBtn");
  let objOn = false;   // lo usa el click del video: elegir objetivo vs. cuentagotas
  const paint = (st) => {
    if (!st || st.disponible === false) return;
    objOn = !!st.objetos;
    if (cBtn) { cBtn.textContent = "🎨 Colores: " + (st.colores ? "ON" : "OFF"); cBtn.classList.toggle("accent", !!st.colores); }
    if (oBtn) { oBtn.textContent = "🧠 Objetos (IA): " + (st.objetos ? "ON" : "OFF"); oBtn.classList.toggle("accent", !!st.objetos); }
    if (fBtn) { fBtn.textContent = "🎯 Seguir: " + (st.follow ? "ON" : "OFF"); fBtn.classList.toggle("accent", !!st.follow); }
    if (nBtn) { nBtn.textContent = "🗣 Narrar: " + (st.narrate ? "ON" : "OFF"); nBtn.classList.toggle("accent", !!st.narrate); }
    document.querySelectorAll("#vFilters [data-vf]").forEach(b => b.classList.toggle("accent", b.dataset.vf === st.filtro));
    if (st.counts) { set("v-col-count", st.counts.colores ?? 0); set("v-obj-count", st.counts.objetos ?? 0); }
    const dets = document.getElementById("v-dets");
    if (dets) dets.innerHTML = (st.detections || []).length
      ? st.detections.map(d => { const t = d.id === st.target;
          return `<span style="color:${t ? "#e0b000" : "inherit"};font-weight:${t ? 700 : 400}">${t ? "🎯" : "▸"} ${d.label} <span style="opacity:.55">#${d.id} · ${Math.round(d.conf * 100)}%</span></span>`;
        }).join("<br>")
      : (st.objetos ? "buscando…" : "—");
    const warn = document.getElementById("vDnnWarn");
    if (warn) warn.style.display = st.dnn === false ? "block" : "none";
  };
  if (cBtn) cBtn.onclick = async () => paint(await api.vision("color"));
  if (oBtn) oBtn.onclick = async () => paint(await api.vision("objects"));
  if (fBtn) fBtn.onclick = async () => { await api.follow(); paint(await api.visionStatus()); };
  if (nBtn) nBtn.onclick = async () => { await api.narrate(); paint(await api.visionStatus()); };
  const cyBtn = document.getElementById("vCycleBtn");
  if (cyBtn) cyBtn.onclick = async () => { await api.cycleTarget(); paint(await api.visionStatus()); };
  const snap = document.getElementById("vSnapBtn");
  if (snap) snap.onclick = async () => {
    const r = await api.snapshot();
    if (r.ok && r.url) window.open(r.url, "_blank"); else alert(r.error || "No se pudo tomar la foto");
  };
  const flip = document.getElementById("vFlipBtn");
  if (flip) flip.onclick = async () => {
    await api.flip();
    const img = document.getElementById("visCam");           // recargar el stream tras reabrir el pipeline
    if (img) setTimeout(() => { img.src = "/api/camera?" + Date.now(); }, 800);
  };
  document.querySelectorAll("#vFilters [data-vf]").forEach(b => b.onclick = async () => paint(await api.visionFilter(b.dataset.vf)));
  const img = document.getElementById("visCam");
  if (img) img.onclick = async (e) => {
    const r = img.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width).toFixed(3), y = ((e.clientY - r.top) / r.height).toFixed(3);
    if (objOn) { await api.targetAt(x, y); paint(await api.visionStatus()); return; }   // elegir a quién seguir
    const res = await api.probe(x, y);                          // si no hay deteccion: cuentagotas
    const box = document.getElementById("v-probe");
    if (!box) return;
    box.innerHTML = res.ok
      ? `<span style="display:inline-block;width:20px;height:20px;border-radius:6px;background:${res.hex};vertical-align:-5px;border:1px solid rgba(255,255,255,.35)"></span>
         &nbsp;<b>${res.nombre}</b> · <code>${res.hex}</code><br>
         <span style="opacity:.7">H ${res.hsv[0]} (tono) · S ${res.hsv[1]} (saturación) · V ${res.hsv[2]} (brillo)</span>`
      : (res.error || "sin datos — ¿está la cámara encendida?");
  };
  api.visionStatus().then(paint);
  if (_visionIV) clearInterval(_visionIV);
  _visionIV = setInterval(() => api.visionStatus().then(paint), 1000);   // refresca detecciones/objetivo
}

/* ---------------- página de inicio: todos los módulos por nivel ---------------- */
const LEVELS = [
  ["control",    "Centro de control", "#8cc63f"],
  ["inicial",    "Nivel inicial",     "#34d399"],
  ["secundaria", "Nivel secundaria",  "#38bdf8"],
  ["superior",   "Nivel superior",    "#a78bfa"],
  ["avanzado",   "Avanzado",          "#f59e0b"],
];
const MODULES = [
  { view: "dashboard",      icon: "⬡",  name: "Dashboard",                level: "control",    desc: "Conduce al robot, mira la cámara y la telemetría en tiempo real." },
  { view: "inicial-drive",  icon: "🎮", name: "Maneja al robot",          level: "inicial",    desc: "Flechas o joystick: conduce a NEO y mira lo que ve con su cámara." },
  { view: "inicial-blocks", icon: "🧩", name: "Programa con bloques",     level: "inicial",    desc: "Arma programas como un rompecabezas y NEO los ejecuta." },
  { view: "inicial-tricks", icon: "⭐", name: "Trucos",                   level: "inicial",    desc: "Saluda, cambia de caminata y otras animaciones divertidas." },
  { view: "sec-blocks",     icon: "🧠", name: "Bloques + sensores",       level: "secundaria", desc: "Bucles y condicionales conectados a los sensores del robot." },
  { view: "sec-lidar",      icon: "🛰", name: "Radar láser 360°",         level: "secundaria", desc: "El LIDAR mide distancias con láser: radar en vivo, marcadores y retos." },
  { view: "sec-ik",         icon: "🦿", name: "Cómo caminan las patas",   level: "secundaria", desc: "Geometría inversa (IK) y las 3 marchas del robot, desde 4 ángulos." },
  { view: "sup-vision",     icon: "👁", name: "Visión artificial",        level: "superior",   desc: "IA que reconoce 80 objetos, detector de colores HSV, filtros y cuentagotas." },
  { view: "sup-slam",       icon: "🗺", name: "Mapeo SLAM",               level: "superior",   desc: "Construye un mapa del entorno con el LIDAR mientras el robot se ubica." },
  { view: "sup-api",        icon: "⌨",  name: "API de programación",      level: "superior",   desc: "Controla al robot desde tu propio código con la API REST." },
  { view: "dev",            icon: "🛠", name: "Modo desarrollador",       level: "avanzado",   desc: "Consola serial del ESP32 y todas las teclas del firmware. Calibración." },
];
window.__go = (view) => { const b = document.querySelector(`.nav-item[data-view="${view}"]`); if (b) b.click(); };
function homeHTML() {
  const groups = {};
  for (const m of MODULES) (groups[m.level] = groups[m.level] || []).push(m);
  return `
    <div class="home-hero"><span class="hh-logo">◣◢</span><div>
      <h1 style="margin:0;font-size:24px">NEO · Centro educativo</h1>
      <p style="margin:3px 0 0;color:var(--muted);font-size:13.5px">Un robot, tres niveles. Elige un módulo para empezar.</p>
    </div></div>` +
    LEVELS.map(([id, label, color]) => !groups[id] ? "" : `
      <div class="home-level">
        <div class="home-level-title"><span class="lv-dot" style="background:${color}"></span>${label}</div>
        <div class="home-grid">${groups[id].map(m => `
          <button class="home-card" style="--lv:${color}" onclick="window.__go('${m.view}')">
            <span class="hc-icon">${m.icon}</span>
            <b>${m.name}</b>
            <p>${m.desc}</p>
          </button>`).join("")}</div>
      </div>`).join("");
}

/* ---------------- vistas / modulos ---------------- */
const views = {
  home: () => homeHTML(),
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
      <div class="panel"><h3>Trucos</h3>
        <div class="btn-row">
          <button class="btn accent" onclick="window.__bark()">🔊 Ladrar / Gruñir</button>
          <button class="btn" onclick="window.__api.raw('w')">👋 Saludar</button>
          <button class="btn" onclick="window.__api.gait()">🐾 Cambiar marcha</button>
        </div>
        <p style="opacity:.65;font-size:12px;margin-top:10px">El ladrido suena en este dispositivo (móvil/PC).</p>
        <div style="margin-top:12px;border-top:1px solid var(--line);padding-top:12px">
          <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);margin-bottom:8px">🗣 NEO habla · voz en el robot</div>
          <div class="btn-row" style="gap:8px">
            <input id="sayInput" placeholder="Escribe algo y NEO lo dice…" onkeydown="if(event.key==='Enter')window.__say()"
              style="flex:1;min-width:150px;padding:11px;border-radius:10px;border:1px solid var(--line-strong);background:var(--panel-2);color:var(--text)">
            <button class="btn accent" onclick="window.__say()">Decir</button>
          </div>
          <div class="btn-row" style="margin-top:8px;gap:6px;flex-wrap:wrap">
            <button class="btn" style="padding:6px 11px;font-size:12px" onclick="window.__sayText('Hola, soy NEO, el robot de la Universidad Valle del Momboy')">Presentarse</button>
            <button class="btn" style="padding:6px 11px;font-size:12px" onclick="window.__sayText('Sistemas en línea, listo para trabajar')">En línea</button>
            <button class="btn" style="padding:6px 11px;font-size:12px" onclick="window.__sayText('Cuidado, obstáculo detectado')">Alerta</button>
          </div>
          <p id="voiceHint" style="opacity:.6;font-size:11px;margin-top:8px">La voz sale por el altavoz conectado al Jetson (requiere <code>espeak-ng</code>).</p>
        </div>
      </div>
    </div>`,

  "inicial-drive": () => head("Maneja al robot", "Conduce y observa lo que ve") + `
    <div class="panels"><div class="panel tall"><h3>Conducir</h3>${controlBar}${dpad}<div id="joyzone" style="display:none"></div></div>
      <div class="panel"><h3>Cámara</h3>${cameraView}</div></div>`,
  "inicial-blocks": () => head("Programa a NEO", "Arrastra bloques, encájalos y dale ▶ Ejecutar") + `
    <div class="blocks-hero"><span class="bh-ico">🧩</span><div>
      <b>Arma tu programa como un rompecabezas</b>
      <p>Cada bloque es una orden para NEO. Encájalos en orden, presiona ▶ Ejecutar, y el perrito de la derecha te muestra lo que va a hacer.</p>
    </div></div>
    <div class="blocks-layout">
      <div class="blocks-main">
        <div class="btn-row" style="margin-bottom:12px">
          <button class="btn accent big" id="runBtn">▶ Ejecutar</button>
          <button class="btn warn big" id="stopBtn">⏹ Detener</button>
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
  "inicial-tricks": () => head("Trucos", "Haz que NEO reaccione") + `
    <div class="panel"><h3>Sonidos y gestos</h3>
      <div class="btn-row">
        <button class="btn accent big" onclick="window.__bark()">🔊 Ladrar / Gruñir</button>
        <button class="btn big" onclick="window.__api.raw('w')">👋 Saludar</button>
        <button class="btn big" onclick="window.__api.raw('2')">🐾 Cambiar caminata</button>
      </div>
      <p style="opacity:.65;font-size:12px;margin-top:12px">El ladrido se reproduce en el altavoz de tu móvil o computadora.</p>
    </div>`,

  "sec-blocks": () => head("Bloques + sensores", "Bucles, condicionales y LIDAR") +
    placeholder("Blockly avanzado", "Bloques con repetir/si-entonces y bloques de sensor (si obstáculo &lt; X → girar). Conecta lógica con el LIDAR.", "Blockly + LIDAR"),
  "sec-lidar": () => head("Radar láser 360° (LIDAR)", "Mira alrededor del robot, detecta objetos y aprende cómo funciona") + `
    <div class="btn-row" id="lidarTabs" style="margin-bottom:14px">
      <button class="btn accent" data-ltab="radar">◎ Radar</button>
      <button class="btn" data-ltab="aprende">📖 Aprende</button>
      <button class="btn" data-ltab="retos">🎯 Retos</button>
    </div>
    <div id="lidarContent"></div>`,
  "sec-ik": () => head("Cómo caminan las patas", "Geometría inversa (IK) y las marchas del robot, desde varios ángulos") + `
    <div class="btn-row" id="ikTabs" style="margin-bottom:14px">
      <button class="btn accent" data-tab="interactivo">✋ Una pata (IK)</button>
      <button class="btn" data-tab="anim">🐾 Marchas</button>
      <button class="btn" data-tab="envivo">📡 En vivo</button>
    </div>
    <div id="ikContent"></div>`,

  "sup-vision": () => head("Visión artificial", "IA que reconoce 80 objetos, colores HSV, filtros de laboratorio y cuentagotas") + visionHTML(),
  "sup-slam": () => head("Mapeo SLAM", "Construye un mapa del entorno") +
    placeholder("Mapa 2D + navegación", "SLAM con el LIDAR: construye un mapa y navega evitando obstáculos.", "LIDAR · avanzado"),
  "sup-api": () => head("API de programación", "Controla el robot por código") + `
    <div class="panel"><h3>Endpoints</h3>
      <div class="placeholder" style="text-align:left;font-family:var(--mono);font-size:12px">
        POST /api/stand · /api/walk · /api/gait<br>POST /api/move/{forward|back|left|right}<br>
        POST /api/stop · /api/raw/{key}<br>GET&nbsp; /api/state · WS /ws/telemetry
        <div class="tag">Docs interactivas en /docs</div>
      </div></div>`,

  "dev": () => head("Modo desarrollador", "Todas las teclas del firmware + consola serial. Calibra desde el móvil.") + `
    <div class="panels" style="display:block">
      <div class="panel"><h3>Consola serial (ESP32)</h3>
        <div id="devConsole" style="height:190px;overflow:auto;background:#05070b;border-radius:10px;padding:10px;font-family:var(--mono);font-size:12px;line-height:1.5;white-space:pre-wrap;color:#9fe8c0">conectando…</div>
        <div class="btn-row" style="margin-top:8px;gap:8px">
          <input id="devRaw" placeholder="tecla…" maxlength="4" style="width:120px;padding:9px;border-radius:8px;border:1px solid #24406a;background:#0a0e14;color:#e6f0ff;font-family:var(--mono)">
          <button class="btn accent" onclick="window.__devRaw && window.__devRaw()">Enviar</button>
          <button class="btn" onclick="var c=document.getElementById('devConsole');if(c)c.textContent=''">Limpiar consola</button>
        </div>
      </div>
      <div class="panel"><h3>Normal · Movimiento y pose</h3>${devKeys([
        ["Stand", " "], ["Walk", "1"], ["Gait", "2"], ["Balance", "3"], ["Flash", "4"],
        ["▲ adelante", "w"], ["▼ atrás", "s"], ["◀ izq", "a"], ["▶ der", "d"],
        ["Yaw −", "q"], ["Yaw +", "e"], ["Altura −", "z"], ["Altura +", "c"]])}</div>
      <div class="panel"><h3>Normal · Marcha y datos</h3>${devKeys([
        ["Vel −", "="], ["Vel +", "-"], ["Paso XY −", "["], ["Paso XY +", "]"],
        ["Paso Z −", ";"], ["Paso Z +", "'"], ["Tip offset −", ","], ["Tip offset +", "."],
        ["💾 Guardar", "9"], ["Cargar", "0"], ["Dump (h)", "h"]])}</div>
      <div class="panel"><h3>Calibración <span style="opacity:.6;font-size:12px">— primero presiona <b>m</b></span></h3>${devKeys([
        ["⚙ m (entrar/salir)", "m"],
        ["Pata 1", "1"], ["Pata 2", "2"], ["Pata 3", "3"], ["Pata 4", "4"],
        ["Coxa (7)", "7"], ["Fémur (8)", "8"], ["Tibia (9)", "9"],
        ["Ajuste − (0.5°)", "-"], ["Ajuste + (0.5°)", "="],
        ["Q-pose idle", "q"], ["W-pose ready", "w"], ["E recta", "e"],
        ["Imprimir offsets", "p"], ["Guardar", "s"], ["Cargar", "l"], ["Limpiar", "c"]])}</div>
    </div>`,
};

/* ---------------- router ---------------- */
function render(view) {
  const root = document.getElementById("view");
  if (_lidarWS) { try { _lidarWS.close(); } catch {} _lidarWS = null; }  // cierra el WS del LIDAR al salir de la vista
  if (_devWS) { try { _devWS.close(); } catch {} _devWS = null; }        // cierra la consola serial al salir
  if (_ikRAF) { cancelAnimationFrame(_ikRAF); _ikRAF = null; }           // detiene la animacion IK al salir
  if (_visionIV) { clearInterval(_visionIV); _visionIV = null; }         // detiene el sondeo de vision al salir
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
  if (view === "sup-vision") setTimeout(mountVision, 0);
  if (view === "dev") setTimeout(mountDev, 0);
  if (view === "inicial-blocks") setTimeout(initBlocks, 0);  // Blockly tras render
}

/* ---------------- menú lateral (hamburguesa en móvil) ---------------- */
const _sidebar = document.querySelector(".sidebar");
const _scrim = document.getElementById("navScrim");
const closeNav = () => { _sidebar?.classList.remove("open"); _scrim?.classList.remove("show"); };
const navToggle = document.getElementById("navToggle");
if (navToggle) navToggle.onclick = () => {
  const open = _sidebar?.classList.toggle("open");
  _scrim?.classList.toggle("show", !!open);
};
if (_scrim) _scrim.onclick = closeNav;

document.querySelectorAll(".nav-item").forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll(".nav-item").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    render(btn.dataset.view);
    closeNav();   // en móvil, cerrar el menú tras elegir
  };
});

/* ---------------- telemetria global ---------------- */
window.__api = api;  // para los onclick inline
connectTelemetry((st) => {
  window.__lastState = st;   // lo usa la vista IK "patas en vivo"
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

render("home");
