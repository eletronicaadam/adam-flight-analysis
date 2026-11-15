/**
 * relatorioPdf.ts — relatório PDF de um trecho, gerado no navegador (porta
 * ampliada de report/pdf_report.py): veredito, eventos, o que não é
 * confiável, métricas, gráficos vetoriais, trajeto e o resumo completo.
 * Carregado só quando o usuário pede o PDF (o jsPDF não pesa no site).
 */
import { jsPDF } from "jspdf";
import type { DadosRelatorio } from "./lib/relatorio";
import type { Serie } from "./lib/dadosVoo";
import { fmt, mmss } from "./formato";

type RGB = [number, number, number];
const COR = {
  texto: [33, 37, 41] as RGB, cinza: [108, 117, 125] as RGB, grade: [222, 226, 230] as RGB, fundo: [246, 247, 249] as RGB,
  destaque: [232, 89, 12] as RGB, critico: [198, 40, 40] as RGB, atencao: [178, 106, 0] as RGB, ok: [46, 125, 50] as RGB,
};
const PALETA: RGB[] = [[31, 119, 180], [255, 127, 14], [44, 160, 44], [214, 39, 40], [148, 103, 189], [140, 86, 75]];
const CORES_GRAVIDADE: Record<string, RGB> = { critico: COR.critico, atencao: COR.atencao, info: COR.cinza };
const NOME_CATEGORIA: Record<string, string> = { bateria: "Bateria", gps: "GPS", altitude: "Altitude", vibracao: "Vibração" };
const NOME_GRAVIDADE: Record<string, string> = { critico: "CRÍTICO", atencao: "ATENÇÃO", info: "info" };

const A4 = { l: 210, a: 297 };
const M = 15; // margem (mm)
const LARG = A4.l - 2 * M;

/** As fontes padrão do PDF só têm o alfabeto latino (WinAnsi): troca o que não cabe nele. */
function limparTexto(s: string): string {
  return s
    .replace(/[—–−]/g, "-").replace(/→/g, "->").replace(/≈/g, "~").replace(/≠/g, "!=").replace(/≤/g, "<=")
    .replace(/≥/g, ">=").replace(/α/g, "alfa").replace(/γ/g, "gama").replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    .replace(/…/g, "...").replace(/ | /g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x00-\xff]/g, "?");
}

class Documento {
  doc = new jsPDF({ unit: "mm", format: "a4" });
  y = M;

  fonte(tam: number, estilo: "normal" | "bold" = "normal", cor: RGB = COR.texto) {
    this.doc.setFont("helvetica", estilo);
    this.doc.setFontSize(tam);
    this.doc.setTextColor(...cor);
  }
  /** Garante `altura` mm livres na página (senão, página nova). */
  espaco(altura: number) {
    if (this.y + altura > A4.a - M - 8) { this.doc.addPage(); this.y = M; }
  }
  texto(s: string, x: number, y: number, opcoes?: { align?: "left" | "center" | "right"; maxWidth?: number }) {
    this.doc.text(limparTexto(s), x, y, opcoes);
  }
  linhas(s: string, largura: number): string[] {
    return this.doc.splitTextToSize(limparTexto(s), largura) as string[];
  }
  /** Parágrafo com quebra de linha; avança o cursor. */
  paragrafo(s: string, tam = 9.5, cor: RGB = COR.texto, x = M, largura = LARG, estilo: "normal" | "bold" = "normal") {
    this.fonte(tam, estilo, cor);
    const passo = tam * 0.42;
    for (const l of this.linhas(s, largura)) {
      this.espaco(passo);
      this.doc.text(l, x, this.y + passo * 0.8);
      this.y += passo;
    }
  }
  titulo(s: string) {
    this.espaco(14);
    this.y += 4;
    this.fonte(13, "bold");
    this.texto(s, M, this.y + 5);
    this.doc.setDrawColor(...COR.destaque);
    this.doc.setLineWidth(0.6);
    this.doc.line(M, this.y + 7, M + 18, this.y + 7);
    this.y += 11;
  }
}

// ---------------------------------------------------------------------
// Gráficos
// ---------------------------------------------------------------------
function escalaBonita(min: number, max: number, alvo = 5): number[] {
  if (!(max > min)) { max = min + 1; min -= 1; }
  const bruto = (max - min) / alvo;
  const pot = 10 ** Math.floor(Math.log10(bruto));
  const passo = [1, 2, 2.5, 5, 10].map((f) => f * pot).find((p) => p >= bruto) ?? bruto;
  const r: number[] = [];
  for (let v = Math.ceil(min / passo) * passo; v <= max + passo * 1e-9; v += passo) r.push(Math.abs(v) < passo * 1e-9 ? 0 : v);
  return r;
}

interface LinhaGrafico { t: (number | null)[]; y: (number | null)[]; nome: string; cor?: RGB; tracejada?: boolean }

function grafico(d: Documento, titulo: string, unidade: string, series: LinhaGrafico[], x0: number, x1: number, altura = 52) {
  const comDados = series.filter((s) => s.y.some((v) => v !== null));
  if (!comDados.length) return;
  d.espaco(altura + 10);
  const doc = d.doc;
  const area = { x: M + 13, y: d.y + 7, w: LARG - 13, h: altura - 14 };
  let ymin = Infinity, ymax = -Infinity;
  for (const s of comDados) for (const v of s.y) if (v !== null) { ymin = Math.min(ymin, v); ymax = Math.max(ymax, v); }
  const pad = (ymax - ymin) * 0.06 || 1;
  const ticksY = escalaBonita(ymin - pad, ymax + pad);
  const yLo = Math.min(ticksY[0], ymin - pad), yHi = Math.max(ticksY[ticksY.length - 1], ymax + pad);
  const px = (t: number) => area.x + ((t - x0) / (x1 - x0 || 1)) * area.w;
  const py = (v: number) => area.y + area.h - ((v - yLo) / (yHi - yLo)) * area.h;

  d.fonte(9.5, "bold");
  d.texto(`${titulo}${unidade ? ` (${unidade})` : ""}`, M, d.y + 3.5);
  // legenda à direita do título
  let lx = M + LARG;
  d.fonte(7.5, "normal", COR.cinza);
  for (const [i, s] of [...comDados.entries()].reverse()) {
    const largura = doc.getTextWidth(limparTexto(s.nome));
    lx -= largura;
    d.texto(s.nome, lx, d.y + 3.5);
    lx -= 6;
    doc.setDrawColor(...(s.cor ?? PALETA[comDados.length - 1 - i]));
    doc.setLineWidth(0.8);
    doc.line(lx, d.y + 2.5, lx + 4.5, d.y + 2.5);
    lx -= 4;
  }
  // grade e eixos
  doc.setLineWidth(0.15);
  doc.setDrawColor(...COR.grade);
  d.fonte(7, "normal", COR.cinza);
  for (const v of ticksY) {
    doc.line(area.x, py(v), area.x + area.w, py(v));
    d.texto(fmt(v, Math.max(0, -Math.floor(Math.log10(Math.abs(ticksY[1] - ticksY[0]) || 1)))) ?? "", area.x - 1.5, py(v) + 1, { align: "right" });
  }
  for (const t of escalaBonita(x0, x1, 6).filter((t) => t >= x0 && t <= x1)) {
    doc.line(px(t), area.y, px(t), area.y + area.h);
    d.texto(mmss(t).replace(/\.\d$/, ""), px(t), area.y + area.h + 3.5, { align: "center" });
  }
  doc.setDrawColor(...COR.cinza);
  doc.rect(area.x, area.y, area.w, area.h);
  // séries (cada trecho contínuo vira uma polilinha)
  comDados.forEach((s, i) => {
    doc.setDrawColor(...(s.cor ?? PALETA[i % PALETA.length]));
    doc.setLineWidth(0.35);
    doc.setLineDashPattern(s.tracejada ? [1.2, 1] : [], 0);
    let run: [number, number][] = [];
    const fechar = () => {
      if (run.length > 1) doc.lines(run.slice(1).map((p, k) => [p[0] - run[k][0], p[1] - run[k][1]]), run[0][0], run[0][1]);
      run = [];
    };
    for (let k = 0; k < s.t.length; k++) {
      const t = s.t[k], v = s.y[k];
      if (t === null || v === null || t < x0 || t > x1) { fechar(); continue; }
      run.push([px(t), py(v)]);
    }
    fechar();
  });
  doc.setLineDashPattern([], 0);
  d.y += altura;
}

const daSerie = (s: Serie | undefined, cor?: RGB): LinhaGrafico[] => (s ? [{ t: s.t, y: s.y, nome: s.nome, cor }] : []);

function trajeto(d: Documento, r: DadosRelatorio) {
  const tr = r.trajeto;
  if (!tr) return;
  const pts: [number, number][] = [];
  let lat0: number | null = null, lng0 = 0;
  for (let i = 0; i < tr.lat.length; i++) {
    const la = tr.lat[i], lo = tr.lng[i];
    if (la === null || lo === null) continue;
    if (lat0 === null) { lat0 = la; lng0 = lo; }
    pts.push([(lo - lng0) * 111_320 * Math.cos((lat0 * Math.PI) / 180), (la - lat0) * 111_320]);
  }
  if (pts.length < 2) return;
  const altura = 95;
  d.espaco(altura + 8);
  d.fonte(9.5, "bold");
  d.texto("Trajeto visto de cima (norte para cima)", M, d.y + 3.5);
  const doc = d.doc;
  const area = { x: M, y: d.y + 6, w: LARG, h: altura - 8 };
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const [xmin, xmax, ymin, ymax] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const escala = Math.min(area.w / (xmax - xmin || 1), area.h / (ymax - ymin || 1)) * 0.92;
  const cx = area.x + area.w / 2 - ((xmin + xmax) / 2) * escala;
  const cy = area.y + area.h / 2 + ((ymin + ymax) / 2) * escala;
  const p = (q: [number, number]): [number, number] => [cx + q[0] * escala, cy - q[1] * escala];
  doc.setFillColor(...COR.fundo);
  doc.rect(area.x, area.y, area.w, area.h, "F");
  doc.setDrawColor(...PALETA[0]);
  doc.setLineWidth(0.5);
  const a = pts.map(p);
  doc.lines(a.slice(1).map((q, k) => [q[0] - a[k][0], q[1] - a[k][1]]), a[0][0], a[0][1]);
  doc.setFillColor(...COR.ok); doc.circle(a[0][0], a[0][1], 1.3, "F");
  doc.setFillColor(...COR.critico); doc.circle(a[a.length - 1][0], a[a.length - 1][1], 1.3, "F");
  // barra de escala
  const metros = escalaBonita(0, ((area.w * 0.25) / escala), 2)[1] ?? 10;
  const bx = area.x + 4, by = area.y + area.h - 4;
  doc.setDrawColor(...COR.texto); doc.setLineWidth(0.4);
  doc.line(bx, by, bx + metros * escala, by);
  d.fonte(7, "normal", COR.cinza);
  d.texto(`${fmt(metros, 0)} m`, bx, by - 1.5);
  d.texto("início", a[0][0] + 2, a[0][1] - 1.5);
  d.texto("fim", a[a.length - 1][0] + 2, a[a.length - 1][1] - 1.5);
  d.y += altura;
}

// ---------------------------------------------------------------------
// Relatório
// ---------------------------------------------------------------------
const maxSerie = (s?: Serie) => (s ? s.y.reduce<number | null>((m, v) => (v !== null && (m === null || v > m) ? v : m), null) : null);

export function gerarRelatorioPdf(r: DadosRelatorio, agora = new Date()): Blob {
  const d = new Documento();
  const doc = d.doc;
  const [ini, fim] = r.trecho;
  const gps = (r.resumo.gps ?? {}) as Record<string, number>;
  const bat = (r.resumo.bateria ?? {}) as Record<string, number>;

  // ---- Cabeçalho ----
  doc.setFillColor(...COR.destaque);
  doc.rect(0, 0, A4.l, 4, "F");
  d.fonte(18, "bold");
  d.texto("Relatório de voo", M, M + 6);
  d.fonte(10, "normal", COR.cinza);
  d.texto("Adam Aerodesign", A4.l - M, M + 6, { align: "right" });
  d.y = M + 10;
  d.paragrafo(r.arquivo, 11, COR.texto, M, LARG, "bold");
  const dataVoo = r.data ? new Date(r.data).toLocaleString("pt-BR", { dateStyle: "long", timeStyle: "short" }) : null;
  d.paragrafo([
    dataVoo ? `Voo em ${dataVoo}` : null,
    `trecho ${mmss(ini)} -> ${mmss(fim)} (${fmt(fim - ini, 0)} s de ${mmss(r.duracaoLog)} de log)`,
    [r.veiculo, r.firmware, r.placa].filter(Boolean).join(" · ") || null,
  ].filter(Boolean).join(" · "), 9, COR.cinza);
  d.y += 3;

  // ---- Veredito ----
  const corV = r.contagem.critico ? COR.critico : r.contagem.atencao ? COR.atencao : COR.ok;
  doc.setFillColor(...corV);
  doc.roundedRect(M, d.y, LARG, 13, 2, 2, "F");
  d.fonte(8, "normal", [255, 255, 255]);
  d.texto("VEREDITO AUTOMÁTICO DO TRECHO", M + 4, d.y + 4.5);
  d.fonte(12.5, "bold", [255, 255, 255]);
  d.texto(r.veredito.toUpperCase(), M + 4, d.y + 10);
  d.fonte(9, "normal", [255, 255, 255]);
  d.texto(`${r.contagem.critico} crítico(s) · ${r.contagem.atencao} de atenção · ${r.contagem.info} informativo(s)`,
    M + LARG - 4, d.y + 8, { align: "right" });
  d.y += 17;

  // ---- Aeronave ----
  const f = r.ficha;
  const ficha = [
    f.nome, f.massa_decolagem_kg ? `${fmt(f.massa_decolagem_kg, 1)} kg` : null,
    f.area_asa_m2 ? `asa ${fmt(f.area_asa_m2, 3)} m²` : null, f.envergadura_m ? `envergadura ${fmt(f.envergadura_m, 2)} m` : null,
    f.bateria.celulas ? `bateria ${f.bateria.celulas}S${f.bateria.capacidade_mah ? ` ${f.bateria.capacidade_mah} mAh` : ""}` : null,
    `controladora ${f.controladora.funcao.replace(/_/g, " ")}, placa ${f.controladora.orientacao.replace(/_/g, " ")}` +
      (f.controladora.calibrada ? "" : ", sem calibração"),
  ].filter(Boolean).join(" · ");
  d.paragrafo(`Aeronave (ficha): ${ficha}`, 8.5, COR.cinza);

  // ---- Métricas ----
  d.titulo("Métricas do trecho");
  const metricas: [string, string | null][] = [
    ["Duração", mmss(fim - ini)], ["Distância", fmt(gps.distancia_percorrida_m, 0, "m")],
    ["Alt. máx. (baro)", fmt(maxSerie(r.series.altitude), 1, "m")], ["Alt. máx. (GPS)", fmt(maxSerie(r.series.altitude_gps), 1, "m")],
    ["Vel. solo máx.", fmt(gps.velocidade_maxima_ms, 1, "m/s")], ["Vel. ar máx.", fmt(maxSerie(r.series.vel_ar), 1, "m/s")],
    ["Consumo", fmt(bat.consumo_mah, 0, "mAh")], ["Energia", fmt(bat.consumo_wh, 1, "Wh")],
    ["Tensão mín.", fmt(bat.tensao_minima_v, 2, "V")], ["Corrente máx.", fmt(bat.corrente_maxima_a, 1, "A")],
    ["Potência máx.", fmt(bat.potencia_maxima_w, 0, "W")],
  ];
  const visiveis = metricas.filter(([, v]) => v !== null) as [string, string][];
  const colunas = 4, lc = LARG / colunas;
  visiveis.forEach(([rotulo, valor], i) => {
    if (i % colunas === 0) d.espaco(13);
    const x = M + (i % colunas) * lc;
    doc.setFillColor(...COR.fundo);
    doc.roundedRect(x, d.y, lc - 2.5, 11.5, 1.5, 1.5, "F");
    d.fonte(7.5, "normal", COR.cinza);
    d.texto(rotulo, x + 2.5, d.y + 4);
    d.fonte(11, "bold");
    d.texto(valor, x + 2.5, d.y + 9.3);
    if (i % colunas === colunas - 1 || i === visiveis.length - 1) d.y += 13.5;
  });
  for (const a of r.avisos) { d.y += 1; d.paragrafo(`Aviso: ${a}`, 8.5, COR.atencao); }

  // ---- O que não é confiável ----
  if (r.qualidade.length) {
    d.titulo("O que não é confiável neste log");
    for (const q of r.qualidade) { d.paragrafo(`-  ${q}`, 9, COR.texto, M + 2, LARG - 2); d.y += 1; }
  }

  // ---- Eventos ----
  d.titulo(`Eventos no trecho (${r.eventos.length})`);
  if (!r.eventos.length) d.paragrafo("Nenhum evento detectado neste trecho.", 9, COR.cinza);
  const ordemG: Record<string, number> = { critico: 0, atencao: 1, info: 2 };
  const eventos = [...r.eventos].sort((a, b) => ordemG[a.gravidade] - ordemG[b.gravidade] || (a.inicio_s ?? -1) - (b.inicio_s ?? -1));
  for (const e of eventos) {
    d.fonte(8.5);
    const desc = d.linhas(e.descricao, LARG - 42);
    const meta = `${e.categoria} · fonte: ${e.fonte}${e.confianca !== "alta" ? ` · confiança ${e.confianca}` : ""}`;
    const alt = 5 + desc.length * 3.6 + 3.4 + 2;
    d.espaco(alt);
    const cor = CORES_GRAVIDADE[e.gravidade];
    doc.setFillColor(...cor);
    doc.rect(M, d.y, 1.2, alt - 2, "F");
    d.fonte(7.5, "bold", cor);
    d.texto(NOME_GRAVIDADE[e.gravidade], M + 3.5, d.y + 3.5);
    d.fonte(8, "normal", COR.cinza);
    d.texto(e.inicio_s === null ? "log todo" : e.fim_s !== null && e.fim_s - e.inicio_s >= 0.5
      ? `${mmss(e.inicio_s)}-${mmss(e.fim_s)}` : mmss(e.inicio_s), M + 3.5, d.y + 7.5);
    d.fonte(9.5, "bold");
    d.texto(`${e.titulo}`, M + 40, d.y + 3.5);
    d.fonte(8.5);
    desc.forEach((l, k) => doc.text(l, M + 40, d.y + 7.5 + k * 3.6));
    d.fonte(7, "normal", COR.cinza);
    d.texto(meta, M + 40, d.y + 7.5 + desc.length * 3.6 + 0.2, { maxWidth: LARG - 42 });
    d.y += alt;
  }

  // ---- Gráficos ----
  d.titulo("Gráficos do trecho");
  const s = r.series;
  grafico(d, "Altitude em relação ao solo", "m", [...daSerie(s.altitude, PALETA[0]), ...daSerie(s.altitude_gps, PALETA[1])], ini, fim);
  grafico(d, "Velocidade", "m/s", [...daSerie(s.vel_solo, PALETA[0]), ...daSerie(s.vel_ar, PALETA[2])], ini, fim);
  grafico(d, "Tensão da bateria", "V", daSerie(s.tensao, PALETA[3]), ini, fim);
  grafico(d, "Corrente", "A", daSerie(s.corrente, PALETA[1]), ini, fim, 44);
  grafico(d, "Potência elétrica", "W", daSerie(s.potencia, PALETA[4]), ini, fim, 44);
  if (r.vibracao.length) {
    grafico(d, "Vibração", "m/s²", [
      ...r.vibracao.map((v, i) => ({ t: v.t, y: v.y, nome: v.nome, cor: [PALETA[3], PALETA[2], PALETA[0]][i] })),
      { t: [ini, fim], y: [30, 30], nome: "atenção (30)", cor: COR.atencao, tracejada: true },
      { t: [ini, fim], y: [60, 60], nome: "crítico (60)", cor: COR.critico, tracejada: true },
    ], ini, fim);
  }
  trajeto(d, r);

  // ---- Resumo completo ----
  d.titulo("Resumo completo do trecho");
  for (const [cat, valores] of Object.entries(r.resumo)) {
    d.espaco(10);
    d.fonte(9.5, "bold");
    d.texto(NOME_CATEGORIA[cat] ?? cat[0].toUpperCase() + cat.slice(1), M, d.y + 4);
    d.y += 6;
    for (const [k, v] of Object.entries(valores as Record<string, unknown>)) {
      d.espaco(4.2);
      d.fonte(8.5, "normal", COR.cinza);
      d.texto(k, M + 3, d.y + 3);
      d.fonte(8.5);
      d.texto(typeof v === "number" ? (Number.isInteger(v) ? String(v) : fmt(v, 3) ?? "") : String(v), M + 85, d.y + 3);
      d.y += 4.2;
    }
    d.y += 2;
  }
  d.y += 3;
  d.paragrafo(`Atitude usada nos eventos: ${r.fonteAtitude ?? "—"}. Tempo em minutos:segundos desde a primeira mensagem do log. ` +
    "Os eventos e o veredito são automáticos: confira as evidências no site (abas Explorador e Saúde) ou no dossiê JSON.",
    8, COR.cinza);

  // ---- Rodapé ----
  const n = doc.getNumberOfPages();
  const gerado = agora.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  for (let p = 1; p <= n; p++) {
    doc.setPage(p);
    d.fonte(7.5, "normal", COR.cinza);
    d.texto(`${r.arquivo} · trecho ${mmss(ini)}-${mmss(fim)} · gerado em ${gerado}`, M, A4.a - 8);
    d.texto(`página ${p} de ${n}`, A4.l - M, A4.a - 8, { align: "right" });
  }
  return doc.output("blob");
}
