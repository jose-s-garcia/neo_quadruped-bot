// blocks.js - Modulo de programacion por bloques (Blockly) para NEO.
// Define bloques propios, un interprete async que ejecuta el programa y
// anima el avatar de NEO segun la accion que se dispara.
import { api } from "./api.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let workspace = null;
let running = false;
let stopped = false;

const DIR_KEY = { adelante: "forward", atras: "back", izquierda: "left", derecha: "right" };

/* ============================ bloques ============================ */
function defineBlocks() {
  Blockly.defineBlocksWithJsonArray([
    {
      type: "neo_move",
      message0: "mover %1 por %2 s",
      args0: [
        { type: "field_dropdown", name: "DIR", options: [
          ["adelante ▲", "adelante"], ["atrás ▼", "atras"],
          ["izquierda ◀", "izquierda"], ["derecha ▶", "derecha"]] },
        { type: "field_number", name: "SEC", value: 1, min: 0.2, max: 10, precision: 0.1 },
      ],
      previousStatement: null, nextStatement: null, colour: 195,
      tooltip: "Mueve a NEO en una dirección durante unos segundos",
    },
    {
      type: "neo_turn", message0: "girar %1",
      args0: [{ type: "field_dropdown", name: "SIDE",
        options: [["izquierda ↺", "izquierda"], ["derecha ↻", "derecha"]] }],
      previousStatement: null, nextStatement: null, colour: 195,
      tooltip: "Gira a NEO sobre su eje",
    },
    { type: "neo_stand", message0: "pararse", previousStatement: null, nextStatement: null,
      colour: 265, tooltip: "NEO se para (stand)" },
    {
      type: "neo_walk", message0: "caminar %1",
      args0: [{ type: "field_dropdown", name: "MODE", options: [["activar", "on"], ["detener", "off"]] }],
      previousStatement: null, nextStatement: null, colour: 265, tooltip: "Activa o detiene la marcha",
    },
    { type: "neo_gait", message0: "cambiar tipo de caminata", previousStatement: null,
      nextStatement: null, colour: 265, tooltip: "Trot → Lateral → Diagonal" },
    {
      type: "neo_trick", message0: "truco %1",
      args0: [{ type: "field_dropdown", name: "NAME",
        options: [["saludar 👋", "saludar"], ["asentir ✓", "asentir"], ["agacharse ⤓", "agacharse"]] }],
      previousStatement: null, nextStatement: null, colour: 290, tooltip: "Una animación divertida",
    },
    {
      type: "neo_wait", message0: "esperar %1 s",
      args0: [{ type: "field_number", name: "SEC", value: 1, min: 0.1, max: 30, precision: 0.1 }],
      previousStatement: null, nextStatement: null, colour: 40, tooltip: "Pausa el programa",
    },
    {
      type: "neo_repeat", message0: "repetir %1 veces %2",
      args0: [
        { type: "field_number", name: "TIMES", value: 3, min: 1, max: 50, precision: 1 },
        { type: "input_statement", name: "DO" }],
      previousStatement: null, nextStatement: null, colour: 120, tooltip: "Repite los bloques de adentro",
    },
  ]);
}

const TOOLBOX = {
  kind: "categoryToolbox",
  contents: [
    { kind: "category", name: "🏃 Movimiento", colour: "195",
      contents: [{ kind: "block", type: "neo_move" }, { kind: "block", type: "neo_turn" }] },
    { kind: "category", name: "⚡ Acciones", colour: "265",
      contents: [{ kind: "block", type: "neo_stand" }, { kind: "block", type: "neo_walk" },
                 { kind: "block", type: "neo_gait" }, { kind: "block", type: "neo_trick" }] },
    { kind: "category", name: "🔁 Control", colour: "120",
      contents: [{ kind: "block", type: "neo_wait" }, { kind: "block", type: "neo_repeat" }] },
  ],
};

const _themes = {};
function getTheme(light) {
  const key = light ? "neoLight" : "neoDark";
  if (_themes[key]) return _themes[key];
  const c = light ? {
    workspaceBackgroundColour: "#f1f5fa", toolboxBackgroundColour: "#ffffff",
    toolboxForegroundColour: "#0f1b2a", flyoutBackgroundColour: "#eef2f8",
    flyoutForegroundColour: "#0f1b2a", scrollbarColour: "#0891b2",
    insertionMarkerColour: "#0891b2", cursorColour: "#0891b2",
  } : {
    workspaceBackgroundColour: "#0b1019", toolboxBackgroundColour: "#0e1622",
    toolboxForegroundColour: "#dbe7f3", flyoutBackgroundColour: "#0d1420",
    flyoutForegroundColour: "#dbe7f3", scrollbarColour: "#22d3ee",
    insertionMarkerColour: "#22d3ee", cursorColour: "#22d3ee",
  };
  _themes[key] = Blockly.Theme.defineTheme(key, {
    base: Blockly.Themes.Classic, componentStyles: c,
    fontStyle: { family: "system-ui, sans-serif", size: 12 },
  });
  return _themes[key];
}

// llamado desde app.js al cambiar el tema (actualiza el workspace en vivo)
export function setBlocklyTheme(light) {
  if (workspace) workspace.setTheme(getTheme(light));
}

/* ====================== avatar + estado ====================== */
function dog(cls) { const d = document.getElementById("neoDog"); if (d) d.className = "neo-dog " + cls; }
function status(txt) { const s = document.getElementById("neoStatus"); if (s) s.textContent = txt; }

/* ====================== runtime de NEO ====================== */
const NEO = {
  async move(dir, sec) {
    dog("act-" + dir); status(`Moviendo ${dir}…`);
    const ticks = Math.max(1, Math.round(sec * 10));
    for (let i = 0; i < ticks && !stopped; i++) { api.move(DIR_KEY[dir]); await sleep(100); }
    api.stop(); dog("idle");
  },
  async turn(side) {
    dog("act-turn-" + side); status(`Girando ${side}…`);
    api.raw(side === "izquierda" ? "q" : "e"); await sleep(500); dog("idle");
  },
  async stand() { dog("act-stand"); status("Parándose…"); api.stand(); await sleep(900); dog("idle"); },
  async walk(mode) { status(mode === "on" ? "Caminando" : "Deteniendo marcha"); api.raw("1"); await sleep(300); },
  async gait() { status("Cambiando caminata…"); api.gait(); await sleep(300); },
  async trick(name) {
    dog("act-" + name); status(`Truco: ${name}`);
    const seqs = {
      saludar:   ["a", "a", "d", "d", "d", "d", "a", "a"],   // balanceo (roll)
      asentir:   ["w", "w", "s", "s", "s", "s", "w", "w"],   // cabeceo (pitch)
      agacharse: ["z", "z", "z", "c", "c", "c"],             // baja y sube
    };
    for (const k of (seqs[name] || [])) { if (stopped) break; api.raw(k); await sleep(250); }
    api.stop(); dog("idle");
  },
  async wait(sec) { status(`Esperando ${sec}s…`); await sleep(sec * 1000); },
};

/* ====================== interprete ====================== */
async function execBlock(b) {
  if (!b || stopped) return;
  switch (b.type) {
    case "neo_move":  await NEO.move(b.getFieldValue("DIR"), Number(b.getFieldValue("SEC"))); break;
    case "neo_turn":  await NEO.turn(b.getFieldValue("SIDE")); break;
    case "neo_stand": await NEO.stand(); break;
    case "neo_walk":  await NEO.walk(b.getFieldValue("MODE")); break;
    case "neo_gait":  await NEO.gait(); break;
    case "neo_trick": await NEO.trick(b.getFieldValue("NAME")); break;
    case "neo_wait":  await NEO.wait(Number(b.getFieldValue("SEC"))); break;
    case "neo_repeat": {
      const n = Number(b.getFieldValue("TIMES"));
      const inner = b.getInputTargetBlock("DO");
      for (let i = 0; i < n && !stopped; i++) await execSeq(inner);
      break;
    }
  }
}
async function execSeq(b) { while (b && !stopped) { await execBlock(b); b = b.getNextBlock(); } }

async function runProgram() {
  if (running || !workspace) return;
  running = true; stopped = false;
  const runBtn = document.getElementById("runBtn");
  if (runBtn) runBtn.disabled = true;
  status("Ejecutando…");
  try {
    for (const top of workspace.getTopBlocks(true)) { await execSeq(top); if (stopped) break; }
  } catch (e) { console.error(e); }
  status(stopped ? "Detenido" : "Programa terminado ✓"); dog("idle");
  running = false; if (runBtn) runBtn.disabled = false;
}

function stopProgram() { stopped = true; api.stop(); status("Detenido"); dog("idle"); }

/* ====================== init ====================== */
export function initBlocks() {
  if (typeof Blockly === "undefined") { status("Blockly no cargó (revisa internet)"); return; }
  defineBlocks();
  if (workspace) { try { workspace.dispose(); } catch {} workspace = null; }
  workspace = Blockly.inject(document.getElementById("blocklyDiv"), {
    toolbox: TOOLBOX,
    theme: getTheme(document.body.classList.contains("light")),
    renderer: "zelos",
    grid: { spacing: 26, length: 2, colour: "#16202e", snap: true },
    zoom: { controls: true, wheel: true, startScale: 0.95 },
    trashcan: true,
    move: { scrollbars: true, drag: true, wheel: true },
  });
  document.getElementById("runBtn").onclick = runProgram;
  document.getElementById("stopBtn").onclick = stopProgram;
  dog("idle"); status("Listo para programar");
}
