/*
 * Replay 3D do voo (componente do Streamlit).
 *
 * Mostra o trajeto em 3D e um modelo simples do avião com a atitude
 * (roll/pitch/rumo) de cada instante, sincronizados por uma barra de tempo.
 * Tudo roda no navegador; a cena só é redesenhada quando algo muda
 * (reprodução, câmera ou cursor), para não gastar CPU/GPU à toa.
 *
 * Eixos da cena (three.js usa Y para cima):
 *   x = leste, y = altura, z = −norte (sul).
 * O modelo aponta o nariz para −z (norte) com rumo 0.
 */
import * as THREE from "three";
import { OrbitControls } from "./vendor/OrbitControls.js";

// ---------------------------------------------------------------------
// Comunicação com o Streamlit (protocolo de componentes v1)
// ---------------------------------------------------------------------
function enviar(tipo, extra) {
  window.parent.postMessage(Object.assign({ isStreamlitMessage: true, type: tipo }, extra), "*");
}
const $ = (id) => document.getElementById(id);

const RAD = Math.PI / 180;
const ESCALA_CORES = [[0, [44, 123, 182]], [0.5, [255, 255, 140]], [1, [215, 25, 28]]];

function fmtTempo(s) {
  const m = Math.floor(Math.max(0, s) / 60);
  const r = Math.max(0, s) - m * 60;
  return m + ":" + (r < 10 ? "0" : "") + r.toFixed(1);
}
const fmt1 = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmt0 = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });

// ---------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------
let P = null, idAtual = null;
let tCursor = 0, tocando = false, ultimoQuadro = 0, precisaRender = true;

// ---------------------------------------------------------------------
// Interpolação
// ---------------------------------------------------------------------
function indiceAnterior(ts, alvo) {
  let lo = 0, hi = ts.length - 1;
  if (alvo <= ts[0]) return 0;
  if (alvo >= ts[hi]) return hi;
  while (hi - lo > 1) {
    const meio = (lo + hi) >> 1;
    if (ts[meio] <= alvo) lo = meio; else hi = meio;
  }
  return lo;
}

function interpolar(serie, chave, t, angulo) {
  const ts = serie.t, ys = serie[chave];
  if (!ts.length) return null;
  const i = indiceAnterior(ts, t);
  const j = Math.min(i + 1, ts.length - 1);
  const a = ys[i], b = ys[j];
  if (a === null || b === null) return a !== null ? a : b;
  if (i === j || ts[j] === ts[i]) return a;
  const f = Math.min(1, Math.max(0, (t - ts[i]) / (ts[j] - ts[i])));
  let d = b - a;
  if (angulo) d = ((d + 540) % 360) - 180;  // menor caminho (359° -> 1°)
  return a + d * f;
}

// ---------------------------------------------------------------------
// Cena
// ---------------------------------------------------------------------
const recipiente = $("cena");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
recipiente.appendChild(renderer.domElement);
const cena = new THREE.Scene();
cena.background = new THREE.Color(0xa8c8e8);
cena.fog = new THREE.Fog(0xa8c8e8, 400, 3000);
const camera = new THREE.PerspectiveCamera(55, 2, 0.1, 10000);
camera.position.set(-60, 40, 60);
const controles = new OrbitControls(camera, renderer.domElement);
controles.enableDamping = false;
controles.addEventListener("change", () => { precisaRender = true; });

cena.add(new THREE.HemisphereLight(0xffffff, 0x556b2f, 1.1));
const sol = new THREE.DirectionalLight(0xffffff, 1.3);
sol.position.set(200, 400, 100);
cena.add(sol);

const chao = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshLambertMaterial({ color: 0x7fa15a }));
chao.rotation.x = -Math.PI / 2;
cena.add(chao);
let grade = null;
const grupoTrajeto = new THREE.Group();
cena.add(grupoTrajeto);

// Seta indicando o norte.
const norte = new THREE.Group();
cena.add(norte);

// ---------- Modelo do avião (dimensões da ficha) ----------
function criarAviao(envergadura) {
  const b = envergadura || 2;
  const corda = b * 0.15, comprimento = b * 0.62;
  const g = new THREE.Group();
  const mat = (c) => new THREE.MeshLambertMaterial({ color: c });
  const fuselagem = new THREE.Mesh(new THREE.BoxGeometry(b * 0.07, b * 0.08, comprimento), mat(0xf5f5f5));
  fuselagem.position.z = -comprimento * 0.05;
  const asa = new THREE.Mesh(new THREE.BoxGeometry(b, b * 0.012, corda), mat(0xffd400));
  asa.position.set(0, b * 0.03, -comprimento * 0.15);
  const pontaDir = new THREE.Mesh(new THREE.BoxGeometry(b * 0.06, b * 0.013, corda * 0.9), mat(0x2ecc71));
  pontaDir.position.set(b * 0.47, b * 0.031, -comprimento * 0.15);   // ponta direita verde
  const pontaEsq = new THREE.Mesh(new THREE.BoxGeometry(b * 0.06, b * 0.013, corda * 0.9), mat(0xe74c3c));
  pontaEsq.position.set(-b * 0.47, b * 0.031, -comprimento * 0.15);  // ponta esquerda vermelha
  const estab = new THREE.Mesh(new THREE.BoxGeometry(b * 0.36, b * 0.01, corda * 0.7), mat(0xffd400));
  estab.position.set(0, b * 0.02, comprimento * 0.42);
  const deriva = new THREE.Mesh(new THREE.BoxGeometry(b * 0.01, b * 0.16, corda * 0.7), mat(0xffd400));
  deriva.position.set(0, b * 0.1, comprimento * 0.42);
  const helice = new THREE.Mesh(new THREE.CircleGeometry(b * 0.11, 24),
    new THREE.MeshBasicMaterial({ color: 0x333333, transparent: true, opacity: 0.35, side: THREE.DoubleSide }));
  helice.position.z = -comprimento * 0.56;
  g.add(fuselagem, asa, pontaDir, pontaEsq, estab, deriva, helice);
  return g;
}
let aviao = criarAviao(2);
const pivo = new THREE.Group();  // recebe posição + atitude
pivo.add(aviao);
cena.add(pivo);

function corPorVelocidade(f) {
  for (let k = 1; k < ESCALA_CORES.length; k++) {
    const [p1, c1] = ESCALA_CORES[k - 1], [p2, c2] = ESCALA_CORES[k];
    if (f <= p2) {
      const u = (f - p1) / (p2 - p1);
      return c1.map((c, i) => (c + (c2[i] - c) * u) / 255);
    }
  }
  return ESCALA_CORES[ESCALA_CORES.length - 1][1].map((c) => c / 255);
}

// Curva que passa pelos pontos na ordem, com parâmetro proporcional ao
// índice (e não ao comprimento): assim o anel i do tubo = ponto i, e dá
// para colorir por ponto e "revelar" o tubo até o instante atual.
class CurvaPorIndice extends THREE.Curve {
  constructor(pontos) { super(); this.pontos = pontos; }
  getPoint(u, alvo = new THREE.Vector3()) {
    const n = this.pontos.length - 1;
    const f = Math.min(Math.max(u, 0), 1) * n;
    const i = Math.min(Math.floor(f), n - 1);
    return alvo.copy(this.pontos[i]).lerp(this.pontos[i + 1], f - i);
  }
  getPointAt(u, alvo) { return this.getPoint(u, alvo); }
  getTangentAt(u, alvo) { return this.getTangent(u, alvo); }
}

const LADOS_TUBO = 6;

// Libera da GPU as geometrias e materiais de um objeto (senão cada
// reconstrução -- exagero, trecho, avião -- deixa memória de vídeo presa).
function descartar(obj) {
  if (!obj) return;
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
  });
}
let trechosTubo = [];   // [{geo, tempos}] -- um por trecho contínuo de GPS

function exagero() { return Number($("exagero").value); }

function construirTrajeto() {
  descartar(grupoTrajeto);
  grupoTrajeto.clear();
  trechosTubo = [];
  const p = P.pos;
  const n = p.t.length;
  const ex = exagero();
  const validos = [];
  for (let i = 0; i < n; i++) if (p.e[i] !== null) validos.push(i);
  if (!validos.length) return;

  // chão, grade e escala da cena a partir da extensão do trajeto
  const xs = validos.map((i) => p.e[i]), zs = validos.map((i) => -p.n[i]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
  const lado = Math.max(100, Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) * 1.6;
  const raio = Math.max(0.25, lado / 380);

  let vmin = Infinity, vmax = -Infinity;
  for (const i of validos) if (p.v[i] !== null) { vmin = Math.min(vmin, p.v[i]); vmax = Math.max(vmax, p.v[i]); }

  // trechos contínuos (o Python marca falhas do GPS com null)
  const trechos = [];
  let atual = [];
  for (let i = 0; i < n; i++) {
    if (p.e[i] === null) { if (atual.length) trechos.push(atual); atual = []; } else atual.push(i);
  }
  if (atual.length) trechos.push(atual);

  const matFundo = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.28 });
  const matPercorrido = new THREE.MeshLambertMaterial({ vertexColors: true });
  for (const trecho of trechos) {
    // Pontos repetidos (avião parado) dão tangente nula e o tubo inteiro
    // vira NaN: fica só o primeiro de cada sequência de pontos iguais.
    const idx = trecho.filter((i, k) => k === 0 || Math.abs(p.e[i] - p.e[trecho[k - 1]]) > 1e-3
      || Math.abs(p.n[i] - p.n[trecho[k - 1]]) > 1e-3 || Math.abs(p.u[i] - p.u[trecho[k - 1]]) > 1e-3);
    if (idx.length < 2) continue;
    const pontos = idx.map((i) => new THREE.Vector3(p.e[i], p.u[i] * ex, -p.n[i]));
    const geo = new THREE.TubeGeometry(new CurvaPorIndice(pontos), idx.length - 1, raio, LADOS_TUBO, false);
    const cores = [];
    for (const i of idx) {
      const f = vmax > vmin && p.v[i] !== null ? (p.v[i] - vmin) / (vmax - vmin) : 0.5;
      const c = corPorVelocidade(f);
      for (let j = 0; j <= LADOS_TUBO; j++) cores.push(...c);
    }
    geo.setAttribute("color", new THREE.Float32BufferAttribute(cores, 3));
    grupoTrajeto.add(new THREE.Mesh(geo, matFundo));
    const percorrido = new THREE.Mesh(geo, matPercorrido);
    grupoTrajeto.add(percorrido);
    // geometria do percorrido = mesmos vértices, índice próprio (para
    // poder mostrar só uma parte sem esconder o tubo de fundo)
    const geoPercorrido = new THREE.BufferGeometry();
    geoPercorrido.setAttribute("position", geo.getAttribute("position"));
    geoPercorrido.setAttribute("normal", geo.getAttribute("normal"));
    geoPercorrido.setAttribute("color", geo.getAttribute("color"));
    geoPercorrido.setIndex(geo.getIndex());
    percorrido.geometry = geoPercorrido;
    trechosTubo.push({ geo: geoPercorrido, tempos: idx.map((i) => p.t[i]) });

    // sombra no solo e linhas verticais (noção de altura)
    const sombraPts = pontos.map((v) => new THREE.Vector3(v.x, 0.05, v.z));
    const geoSombra = new THREE.BufferGeometry().setFromPoints(sombraPts);
    const linhaSombra = new THREE.Line(geoSombra, new THREE.LineBasicMaterial({ color: 0x333333, transparent: true, opacity: 0.4 }));
    linhaSombra.userData.sombra = true;
    linhaSombra.visible = $("sombra").checked;
    grupoTrajeto.add(linhaSombra);
    const verticais = [];
    let ultimo = -Infinity;
    idx.forEach((i, k) => {
      if (p.t[i] - ultimo < 2) return;
      ultimo = p.t[i];
      verticais.push(pontos[k].x, 0, pontos[k].z, pontos[k].x, pontos[k].y, pontos[k].z);
    });
    const geoV = new THREE.BufferGeometry();
    geoV.setAttribute("position", new THREE.Float32BufferAttribute(verticais, 3));
    const linhasV = new THREE.LineSegments(geoV, new THREE.LineBasicMaterial({ color: 0x444444, transparent: true, opacity: 0.3 }));
    linhasV.userData.sombra = true;
    linhasV.visible = $("sombra").checked;
    grupoTrajeto.add(linhasV);
  }
  // início (verde) e fim (vermelho)
  const marcador = (cor, i) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(raio * 1.8, 16, 12), new THREE.MeshLambertMaterial({ color: cor }));
    m.position.set(p.e[i], p.u[i] * ex, -p.n[i]);
    grupoTrajeto.add(m);
  };
  marcador(0x2ecc71, validos[0]);
  marcador(0xe74c3c, validos[validos.length - 1]);

  chao.scale.set(lado * 3, lado * 3, 1);
  chao.position.set(cx, 0, cz);
  if (grade) { cena.remove(grade); descartar(grade); }
  const celula = lado > 600 ? 50 : 10;
  grade = new THREE.GridHelper(Math.ceil(lado / celula) * celula, Math.ceil(lado / celula), 0x4d6b3a, 0x6b8a4e);
  grade.position.set(cx, 0.02, cz);
  cena.add(grade);
  descartar(norte);
  norte.clear();
  norte.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(cx - lado / 2.4, 0.5, cz),
                                  lado * 0.12, 0xd62728, lado * 0.04, lado * 0.025));
  P._centro = new THREE.Vector3(cx, 0, cz);
  P._lado = lado;
  // Neblina e alcance da câmera proporcionais ao voo (voos grandes sumiam na visão geral).
  cena.fog.near = Math.max(400, lado * 2);
  cena.fog.far = Math.max(3000, lado * 8);
  camera.far = Math.max(10000, lado * 20);
  camera.updateProjectionMatrix();
}

function revelarPercorrido() {
  // cada segmento do tubo tem LADOS_TUBO * 6 índices
  for (const tr of trechosTubo) {
    let segmentos;
    if (tCursor <= tr.tempos[0]) segmentos = 0;
    else if (tCursor >= tr.tempos[tr.tempos.length - 1]) segmentos = tr.tempos.length - 1;
    else segmentos = indiceAnterior(tr.tempos, tCursor) + 1;
    tr.geo.setDrawRange(0, segmentos * LADOS_TUBO * 6);
  }
}

// ---------------------------------------------------------------------
// Atualização por instante
// ---------------------------------------------------------------------
const alvoCamera = new THREE.Vector3();
function atualizarCena() {
  if (!P || !P.pos.t.length) return;
  const e = interpolar(P.pos, "e", tCursor), n = interpolar(P.pos, "n", tCursor), u = interpolar(P.pos, "u", tCursor);
  if (e === null) return;
  pivo.position.set(e, u * exagero(), -n);
  const roll = P.att ? interpolar(P.att, "roll", tCursor) : 0;
  const pitch = P.att ? interpolar(P.att, "pitch", tCursor) : 0;
  const yaw = P.att ? interpolar(P.att, "yaw", tCursor, true) : (interpolar(P.pos, "rumo", tCursor, true) || 0);
  // ordem: rumo (em torno do eixo vertical), depois pitch, depois roll
  pivo.rotation.set((pitch || 0) * RAD, -(yaw || 0) * RAD, -(roll || 0) * RAD, "YXZ");

  revelarPercorrido();

  // câmera
  const modo = $("camera").value;
  const escala = Number($("escala").value);
  if (modo === "perseguicao") {
    const tamanho = (P.envergadura_m || 2) * Math.max(escala, 1);
    const distancia = tamanho * 3.2, altura = tamanho * 1.1;
    const r = (yaw || 0) * RAD;
    // atrás do avião (oposto ao rumo) e um pouco acima
    const y = u * exagero();
    camera.position.set(e - Math.sin(r) * distancia, y + altura, -n + Math.cos(r) * distancia);
    alvoCamera.set(e, y, -n);
    camera.lookAt(alvoCamera);
  } else if (modo === "livre") {
    controles.target.set(e, u * exagero(), -n);
    controles.update();
  }

  const v = interpolar(P.pos, "v", tCursor);
  $("hud").innerHTML =
    `<b>${fmtTempo(tCursor)}</b><br>` +
    `Velocidade solo: <b>${v === null ? "—" : fmt1.format(v)} m/s</b><br>` +
    `Altura (${P.fonte_altura}): <b>${u === null ? "—" : fmt1.format(u)} m</b><br>` +
    `Roll: <b>${fmt0.format(roll || 0)}°</b> · Pitch: <b>${fmt0.format(pitch || 0)}°</b><br>` +
    `Rumo: <b>${fmt0.format(((yaw || 0) + 360) % 360)}°</b>`;

  // aviso de evento próximo do instante
  const ev = (P.eventos || []).find((x) => tCursor >= x.t - 0.3 && tCursor <= x.fim + 1.5);
  const caixa = $("evento");
  if (ev) {
    caixa.textContent = fmtTempo(ev.t) + " — " + ev.titulo;
    caixa.className = "evento " + ev.gravidade;
    caixa.hidden = false;
  } else {
    caixa.hidden = true;
  }
  $("tempo").value = String(tCursor);
  $("rotulo-tempo").textContent = fmtTempo(tCursor) + " / " + fmtTempo(P.fim);
  precisaRender = true;
}

function enquadrarGeral() {
  if (!P || !P._centro) return;
  const c = P._centro, l = P._lado;
  camera.position.set(c.x - l * 0.35, l * 0.45, c.z + l * 0.55);
  controles.target.copy(c);
  controles.update();
  precisaRender = true;
}

// ---------------------------------------------------------------------
// Laço de desenho (só desenha quando necessário)
// ---------------------------------------------------------------------
function quadro(agora) {
  if (tocando && P) {
    const dt = Math.min(0.25, (agora - ultimoQuadro) / 1000);
    ultimoQuadro = agora;
    tCursor += dt * Number($("velocidade").value);
    if (tCursor >= P.fim) { tCursor = P.fim; pausar(); }
    atualizarCena();
  }
  if (precisaRender) {
    renderer.render(cena, camera);
    precisaRender = false;
  }
  requestAnimationFrame(quadro);
}

function tocar() {
  if (!P) return;
  if (tCursor >= P.fim - 0.05) tCursor = P.inicio;
  tocando = true;
  ultimoQuadro = performance.now();
  $("play").textContent = "⏸";
}
function pausar() {
  tocando = false;
  $("play").textContent = "▶";
}
function irPara(t) {
  if (!P) return;
  tCursor = Math.min(P.fim, Math.max(P.inicio, t));
  atualizarCena();
}

// ---------------------------------------------------------------------
// Construção
// ---------------------------------------------------------------------
function construir(dados) {
  P = dados;
  idAtual = dados.id;
  pausar();
  $("vazio").hidden = !!(P.pos && P.pos.t.length);
  if (!P.pos || !P.pos.t.length) return;
  pivo.remove(aviao);
  descartar(aviao);
  aviao = criarAviao(P.envergadura_m);
  aviao.scale.setScalar(Number($("escala").value));
  pivo.add(aviao);
  construirTrajeto();
  $("tempo").min = String(P.inicio);
  $("tempo").max = String(P.fim);
  tCursor = P.inicio;
  // marcas de eventos na barra de tempo
  const marcas = $("marcas");
  marcas.textContent = "";
  for (const ev of P.eventos || []) {
    const div = document.createElement("div");
    div.className = "marca " + ev.gravidade;
    div.style.left = (100 * (ev.t - P.inicio) / Math.max(P.fim - P.inicio, 1e-6)) + "%";
    div.title = fmtTempo(ev.t) + " — " + ev.titulo;
    marcas.appendChild(div);
  }
  $("legenda").textContent =
    "Atitude: " + P.fonte_atitude + ". Altura: " + P.fonte_altura + " em relação ao solo. " +
    "Cor do trajeto: velocidade (azul = lenta, vermelho = rápida). Ponta da asa direita verde, esquerda vermelha. " +
    "Marcas na barra de tempo = eventos detectados (vermelho = crítico, laranja = atenção).";
  if ($("camera").value === "geral" || $("camera").value === "livre") enquadrarGeral();
  atualizarCena();
}

function aplicarTema(tema) {
  if (!tema) return;
  const raiz = document.documentElement.style;
  if (tema.backgroundColor) raiz.setProperty("--fundo", tema.backgroundColor);
  if (tema.secondaryBackgroundColor) raiz.setProperty("--fundo2", tema.secondaryBackgroundColor);
  if (tema.textColor) {
    raiz.setProperty("--texto", tema.textColor);
    raiz.setProperty("--texto2", "color-mix(in srgb, " + tema.textColor + " 62%, transparent)");
    raiz.setProperty("--borda", "color-mix(in srgb, " + tema.textColor + " 15%, transparent)");
  }
  if (tema.primaryColor) raiz.setProperty("--destaque", tema.primaryColor);
  if (tema.font) raiz.setProperty("--fonte", tema.font + ", system-ui, sans-serif");
}

// ---------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------
window.addEventListener("message", (ev) => {
  const msg = ev.data;
  if (!msg || msg.type !== "streamlit:render") return;
  aplicarTema(msg.theme);
  const dados = msg.args && msg.args.dados;
  if (!dados || dados.id === idAtual) return;
  construir(dados);
});

$("play").addEventListener("click", () => (tocando ? pausar() : tocar()));
$("ir-inicio").addEventListener("click", () => irPara(P ? P.inicio : 0));
$("voltar").addEventListener("click", () => irPara(tCursor - 10));
$("avancar").addEventListener("click", () => irPara(tCursor + 10));
$("tempo").addEventListener("input", () => { pausar(); irPara(Number($("tempo").value)); });
$("camera").addEventListener("change", () => {
  controles.enabled = $("camera").value !== "perseguicao";
  if ($("camera").value !== "perseguicao") enquadrarGeral();
  atualizarCena();
});
$("escala").addEventListener("change", () => { aviao.scale.setScalar(Number($("escala").value)); atualizarCena(); });
$("sombra").addEventListener("change", () => {
  grupoTrajeto.children.forEach((obj) => { if (obj.userData.sombra) obj.visible = $("sombra").checked; });
  precisaRender = true;
});
$("exagero").addEventListener("change", () => { if (P && P.pos.t.length) { construirTrajeto(); atualizarCena(); } });
controles.enabled = false;  // câmera começa em "perseguição"

document.addEventListener("keydown", (ev) => {
  if (!P || ev.target.tagName === "SELECT") return;
  if (ev.code === "Space") { ev.preventDefault(); tocando ? pausar() : tocar(); }
  else if (ev.key === "Home") { ev.preventDefault(); irPara(P.inicio); }
  else if ((ev.key === "ArrowRight" || ev.key === "ArrowLeft") && ev.target.id !== "tempo") {
    ev.preventDefault();
    irPara(tCursor + (ev.shiftKey ? 10 : 1) * (ev.key === "ArrowRight" ? 1 : -1));
  }
});

// Tamanho: largura do iframe, altura fixa da cena.
let ultimaAltura = 0;
new ResizeObserver(() => {
  const largura = recipiente.clientWidth, altura = recipiente.clientHeight;
  renderer.setSize(largura, altura, false);
  renderer.domElement.style.width = largura + "px";
  renderer.domElement.style.height = altura + "px";
  camera.aspect = largura / Math.max(altura, 1);
  camera.updateProjectionMatrix();
  precisaRender = true;
  const h = Math.ceil($("app").getBoundingClientRect().height) + 6;
  if (h !== ultimaAltura) { ultimaAltura = h; enviar("streamlit:setFrameHeight", { height: h }); }
}).observe($("app"));

window.__replay = { get t() { return tCursor; }, get tocando() { return tocando; } };
requestAnimationFrame(quadro);
enviar("streamlit:componentReady", { apiVersion: 1 });
