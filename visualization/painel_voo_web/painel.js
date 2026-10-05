/*
 * Painel interativo de voo (componente do Streamlit).
 *
 * Tudo que acontece ao mover o mouse, tocar a reprodução ou dar zoom roda
 * aqui no navegador -- o Python só é chamado de novo quando o usuário
 * escolhe outro arquivo ou outro trecho. Por isso a interação é fluida
 * mesmo com logs grandes.
 *
 * Sincronização: existe um único "instante do cursor" (tCursor). Gráficos,
 * mapa, valores instantâneos e linha do tempo leem esse valor; quem muda o
 * instante (mouse nos gráficos, mouse no trajeto, slider, reprodução)
 * chama definirCursor() e o resto é redesenhado no próximo quadro.
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Comunicação com o Streamlit (protocolo de componentes v1)
  // ---------------------------------------------------------------------
  function enviar(tipo, extra) {
    window.parent.postMessage(Object.assign({ isStreamlitMessage: true, type: tipo }, extra), "*");
  }
  const Streamlit = {
    pronto: () => enviar("streamlit:componentReady", { apiVersion: 1 }),
    altura: (h) => enviar("streamlit:setFrameHeight", { height: h }),
    valor: (v) => enviar("streamlit:setComponentValue", { value: v, dataType: "json" }),
  };

  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------------
  // Configuração visual
  // ---------------------------------------------------------------------
  const LINHAS_GRAFICO = [
    { titulo: "Velocidade (m/s)", series: ["vel_solo", "vel_ar"] },
    { titulo: "Altitude (m)", series: ["altitude", "altitude_gps"] },
    { titulo: "Tensão (V)", series: ["tensao"] },
    { titulo: "Corrente (A)", series: ["corrente"] },
    { titulo: "Potência (W)", series: ["potencia"] },
  ];
  const COR_SERIE = {
    vel_solo: "#1f77b4", vel_ar: "#17becf", altitude: "#2ca02c", altitude_gps: "#8c564b",
    tensao: "#9467bd", corrente: "#ff7f0e", potencia: "#d62728",
  };
  const CARTOES = [
    { chave: "tempo", nome: "Tempo" },
    { chave: "vel_solo", nome: "Velocidade solo", casas: 1, unidade: "m/s", kmh: true },
    { chave: "vel_ar", nome: "Velocidade do ar", casas: 1, unidade: "m/s", kmh: true },
    { chave: "altitude", nome: "Altitude (baro)", casas: 1, unidade: "m" },
    { chave: "altitude_gps", nome: "Altitude (GPS)", casas: 1, unidade: "m" },
    { chave: "tensao", nome: "Tensão", casas: 2, unidade: "V" },
    { chave: "corrente", nome: "Corrente", casas: 1, unidade: "A" },
    { chave: "potencia", nome: "Potência", casas: 0, unidade: "W" },
    { chave: "consumo", nome: "Consumo no trecho", casas: 0, unidade: "mAh" },
    { chave: "modo", nome: "Modo de voo" },
  ];
  // Cores para séries sem cor definida (abas personalizadas).
  const PALETA = ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd",
                  "#8c564b", "#e377c2", "#17becf", "#bcbd22", "#7f7f7f"];

  // O Python pode personalizar o painel (abas): linhas de gráfico,
  // cartões, cores e se o mapa aparece. Sem isso, usa o painel do voo.
  const linhasDoPainel = () => P.linhas || LINHAS_GRAFICO;
  const cartoesDoPainel = () => P.cartoes || CARTOES;
  function corDaSerie(chave, indice) {
    return (P.cores && P.cores[chave]) || COR_SERIE[chave] || PALETA[indice % PALETA.length];
  }

  // Escala de cores do trajeto (azul = baixo, vermelho = alto).
  const ESCALA = ["#2c7bb6", "#00a6ca", "#00ccbc", "#90eb9d", "#ffff8c",
                  "#f9d057", "#f29e2e", "#e76818", "#d7191c", "#a50f15"];
  const COR_TRAJETO_UNICA = "#00e5ff";
  // Falhas reais no log (ex: GPS sem fix) chegam do Python como um ponto
  // null entre as amostras. Até esta distância (s) de uma amostra válida
  // ainda mostramos o valor dela.
  const TOLERANCIA_S = 0.5;
  // Duração mínima do trecho que pode ser enviado para análise (igual ao Python).
  const TRECHO_MINIMO_S = 1;

  const AVIAO_SVG =
    '<svg width="30" height="30" viewBox="0 0 30 30"><path fill="#ffd400" stroke="#000" stroke-width="1" ' +
    'd="M15 2 L17 11 L28 16 L28 18 L17 16 L16.5 24 L20 27 L20 28 L15 26.5 L10 28 L10 27 L13.5 24 L13 16 L2 18 L2 16 L13 11 Z"/></svg>';

  const formatadores = {};
  function fmt(valor, casas) {
    if (!formatadores[casas]) {
      formatadores[casas] = new Intl.NumberFormat("pt-BR", {
        minimumFractionDigits: casas, maximumFractionDigits: casas,
      });
    }
    return formatadores[casas].format(valor);
  }
  function fmtTempo(s) {
    const sinal = s < 0 ? "-" : "";
    s = Math.abs(s);
    const m = Math.floor(s / 60);
    const resto = s - m * 60;
    return sinal + m + ":" + (resto < 10 ? "0" : "") + resto.toFixed(1);
  }

  // ---------------------------------------------------------------------
  // Estado
  // ---------------------------------------------------------------------
  let P = null;               // pacote de dados vindo do Python
  let idAtual = null;
  let tCursor = 0;
  let origemCursor = null;    // quem moveu o cursor por último ("mapa" ou null)
  let quadroPendente = false;
  let tocando = false;
  let ultimoQuadro = 0;
  let faixaZoom = null;       // [ini, fim] visível nos gráficos, ou null
  let temaEscuro = false;
  let graficoPronto = false;

  let mapa = null, camadaTrajeto = null, marcador = null, svgAviao = null;
  let trajetoPx = null;       // cache do trajeto em pixels (hover no mapa)
  let serieLat = null, serieLng = null, serieRumo = null;
  let ultimoLinkGmaps = "";
  let mapaMexidoPeloUsuario = false;  // depois disso, não reenquadramos sozinhos

  // Contadores de redesenho: gráficos e trajeto só devem ser redesenhados
  // quando chegam dados novos, tema novo, zoom ou mudança de tamanho --
  // nunca ao mover o mouse ou durante a reprodução (isso causaria piscadas).
  const depuracao = { graficos: 0, trajeto: 0, redimensionamentos: 0 };
  window.__painelVoo = depuracao;

  const elCartoes = {};
  const gd = $("graficos");
  const elCursor = $("cursor");
  const slider = $("tempo");

  // ---------------------------------------------------------------------
  // Busca de valores no instante t
  // ---------------------------------------------------------------------
  // Índice da última amostra com t <= alvo (busca binária).
  function indiceAnterior(ts, alvo) {
    let lo = 0, hi = ts.length - 1;
    if (alvo < ts[0]) return -1;
    if (alvo >= ts[hi]) return hi;
    while (hi - lo > 1) {
      const meio = (lo + hi) >> 1;
      if (ts[meio] <= alvo) lo = meio; else hi = meio;
    }
    return lo;
  }

  // Valor interpolado da série no instante t (null fora da série ou
  // dentro de uma falha do log, marcada com null pelo Python).
  function valorEm(serie, t, semInterpolar) {
    if (!serie || !serie.t.length) return null;
    const ts = serie.t, ys = serie.y, n = ts.length;
    // Mensagens lentas (ex: 1 amostra a cada 5 s) ganham tolerância maior.
    const tolerancia = Math.max(TOLERANCIA_S, n > 1 ? (ts[n - 1] - ts[0]) / (n - 1) : 0);
    if (t < ts[0] - tolerancia || t > ts[n - 1] + tolerancia) return null;
    const i = indiceAnterior(ts, t);
    if (i < 0) return ys[0];
    if (i >= n - 1) return ys[n - 1];
    const a = ys[i], b = ys[i + 1];
    const t0 = ts[i], t1 = ts[i + 1];
    if (a === null || b === null) {
      if (a !== null && t - t0 <= TOLERANCIA_S) return a;
      if (b !== null && t1 - t <= TOLERANCIA_S) return b;
      return null;
    }
    if (semInterpolar) return a;
    return a + (b - a) * ((t - t0) / (t1 - t0 || 1));
  }

  function modoEm(t) {
    let nome = null;
    for (const m of P.modos) {
      if (m.t <= t) nome = m.nome; else break;
    }
    return nome;
  }

  // ---------------------------------------------------------------------
  // Valores instantâneos
  // ---------------------------------------------------------------------
  function montarCartoes() {
    const caixa = $("valores");
    caixa.textContent = "";
    for (const k in elCartoes) delete elCartoes[k];
    for (const c of cartoesDoPainel()) {
      if (c.chave === "modo" && !P.modos.length) continue;
      if (c.chave !== "tempo" && c.chave !== "modo" && !P.series[c.chave]) continue;
      const div = document.createElement("div");
      div.className = "valor";
      div.innerHTML = '<div class="nome"></div><div class="numero">—</div><div class="extra">&nbsp;</div>';
      div.querySelector(".nome").textContent = c.nome;
      caixa.appendChild(div);
      elCartoes[c.chave] = {
        def: c,
        numero: div.querySelector(".numero"),
        extra: div.querySelector(".extra"),
        ultimo: null,
      };
    }
  }

  function escrever(cartao, numero, extra) {
    // Só mexe no DOM se o texto mudou (evita trabalho a cada quadro).
    const chave = numero + "|" + extra;
    if (cartao.ultimo === chave) return;
    cartao.ultimo = chave;
    cartao.numero.textContent = numero;
    cartao.extra.textContent = extra || " ";
  }

  function atualizarCartoes() {
    for (const chave in elCartoes) {
      const cartao = elCartoes[chave];
      const c = cartao.def;
      if (chave === "tempo") {
        escrever(cartao, fmtTempo(tCursor), "t = " + fmt(tCursor, 1) + " s");
      } else if (chave === "modo") {
        escrever(cartao, modoEm(tCursor) || "—", "");
      } else {
        const v = valorEm(P.series[chave], tCursor);
        if (v === null) {
          escrever(cartao, "—", "");
        } else {
          const extra = c.kmh ? fmt(v * 3.6, 0) + " km/h" : "";
          escrever(cartao, fmt(v, c.casas === undefined ? 2 : c.casas) + (c.unidade ? " " + c.unidade : ""), extra);
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // Gráficos (Plotly, um único eixo X compartilhado = zoom sincronizado)
  // ---------------------------------------------------------------------
  function corDoModo(nome) {
    let h = 0;
    for (let i = 0; i < nome.length; i++) h = (h * 31 + nome.charCodeAt(i)) % 360;
    return "hsla(" + h + ", 70%, 50%, 0.09)";
  }

  function coresDoTema() {
    const estilo = getComputedStyle(document.documentElement);
    return {
      texto: estilo.getPropertyValue("--texto").trim() || "#31333f",
      grade: temaEscuro ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.08)",
    };
  }

  function montarGraficos() {
    const linhas = linhasDoPainel().filter((l) => l.series.some((s) => P.series[s]));
    // Altura proporcional ao número de linhas (o Explorador pode ter até 12):
    // cada gráfico fica com pelo menos ~100 px.
    const alturaPx = Math.max(320, Math.min(1600, 115 * linhas.length + 70));
    if (gd.style.height !== alturaPx + "px") gd.style.height = alturaPx + "px";
    $("graficos-vazio").hidden = linhas.length > 0;
    if (!linhas.length) {
      if (graficoPronto) Plotly.purge(gd);
      graficoPronto = false;
      elCursor.hidden = true;
      return Promise.resolve();
    }

    const cores = coresDoTema();
    const n = linhas.length;
    // Painéis das abas (personalizados) têm títulos longos: vão em cima de
    // cada gráfico (e não na vertical) e a legenda vai para baixo.
    const personalizado = !!P.linhas;
    // Espaço entre gráficos fixo em pixels (~30 px para o título), não em fração.
    const espaco = personalizado ? Math.min(0.15, 30 / Math.max(200, alturaPx - 110)) : 0.045;
    const altura = (1 - espaco * (n - 1)) / n;
    const tracos = [];
    const layout = {
      margin: { l: 58, r: 12, t: 24, b: 38 },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      font: { color: cores.texto, size: 11 },
      hovermode: false,
      dragmode: "zoom",
      showlegend: false,
      shapes: [],
      annotations: [],
      uirevision: idAtual,
    };

    linhas.forEach((linha, i) => {
      const sufixo = i === 0 ? "" : String(i + 1);
      const topo = 1 - i * (altura + espaco);
      layout["yaxis" + sufixo] = {
        domain: [Math.max(0, topo - altura), topo],
        title: personalizado ? undefined : { text: linha.titulo, font: { size: 11 } },
        fixedrange: true,
        zeroline: false,
        gridcolor: cores.grade,
      };
      if (personalizado) {
        layout.annotations.push({
          x: 0, y: topo, xref: "paper", yref: "paper", xanchor: "left", yanchor: "bottom",
          text: "<b>" + linha.titulo + "</b>", showarrow: false, font: { size: 11, color: cores.texto },
        });
      }
      const presentes = linha.series.filter((s) => P.series[s]);
      for (const chave of presentes) {
        const s = P.series[chave];
        tracos.push({
          type: "scattergl",
          mode: "lines",
          x: s.t,
          y: s.y,
          name: s.nome,
          xaxis: "x",
          yaxis: "y" + sufixo,
          line: (P.tracejadas || []).includes(chave)
            ? { color: corDaSerie(chave, tracos.length), width: 1, dash: "dash" }
            : { color: corDaSerie(chave, tracos.length), width: 1.5 },
          hoverinfo: "skip",
          connectgaps: false,
          showlegend: presentes.length > 1,
        });
      }
      if (presentes.length > 1) layout.showlegend = true;
    });

    layout.xaxis = {
      anchor: "y" + (n === 1 ? "" : String(n)),
      range: [P.inicio, P.fim],
      title: { text: "Tempo (s)", font: { size: 11 } },
      zeroline: false,
      gridcolor: cores.grade,
    };
    if (personalizado) {
      // Legenda abaixo do eixo do tempo, com espaço reservado na margem.
      const itens = tracos.filter((t) => t.showlegend).length;
      const linhasLegenda = Math.ceil(itens / 4);
      layout.margin = { l: 58, r: 12, t: 26, b: 44 + 20 * linhasLegenda };
      const alturaGrafico = Math.max(100, alturaPx - layout.margin.t - layout.margin.b);
      layout.legend = {
        orientation: "h", x: 0, xanchor: "left", y: -40 / alturaGrafico, yanchor: "top",
        font: { size: 10 },
      };
    } else {
      layout.legend = {
        orientation: "h", x: 0.01, xanchor: "left", y: 0.995, yanchor: "top",
        font: { size: 10 }, bgcolor: temaEscuro ? "rgba(14,17,23,0.7)" : "rgba(255,255,255,0.7)",
      };
    }

    // Faixas coloridas com o modo de voo ativo em cada trecho. Rótulos
    // muito próximos do anterior são omitidos (a faixa continua visível
    // e o cartão "Modo de voo" mostra o nome).
    const distanciaMinima = (P.fim - P.inicio) * 0.07;
    let ultimoRotulo = -Infinity;
    P.modos.forEach((m, i) => {
      const fim = i + 1 < P.modos.length ? P.modos[i + 1].t : P.fim;
      layout.shapes.push({
        type: "rect", xref: "x", yref: "paper", x0: m.t, x1: fim, y0: 0, y1: 1,
        fillcolor: corDoModo(m.nome), line: { width: 0 }, layer: "below",
      });
      // Nos painéis das abas o topo é do título do gráfico: só as faixas.
      if (!personalizado && m.t - ultimoRotulo >= distanciaMinima) {
        ultimoRotulo = m.t;
        layout.annotations.push({
          x: m.t, y: 1, xref: "x", yref: "paper", xanchor: "left", yanchor: "bottom",
          text: m.nome, showarrow: false, font: { size: 9, color: cores.texto }, opacity: 0.75,
        });
      }
    });

    const config = {
      displaylogo: false,
      responsive: false,
      scrollZoom: false,
      doubleClick: "reset",
      displayModeBar: "hover",
      modeBarButtonsToRemove: ["select2d", "lasso2d", "autoScale2d", "toImage"],
    };

    depuracao.graficos++;
    return Plotly.react(gd, tracos, layout, config).then(() => {
      if (!graficoPronto) gd.on("plotly_relayout", aoMudarZoom);
      graficoPronto = true;
      posicionarCursorGrafico();
    });
  }

  function aoMudarZoom() {
    const xa = gd._fullLayout && gd._fullLayout.xaxis;
    if (!xa) return;
    const [a, b] = xa.range;
    const total = P.fim - P.inicio;
    const ehZoom = (a - P.inicio) > total * 0.002 || (P.fim - b) > total * 0.002;
    let nova = ehZoom ? [Math.max(P.inicio, a), Math.min(P.fim, b)] : null;
    // Arrastar (pan) para fora dos dados pode inverter a faixa.
    if (nova && !(nova[1] > nova[0])) nova = null;
    // plotly_relayout também dispara em redimensionamentos; só redesenha
    // o trajeto se a faixa de zoom realmente mudou.
    const mudou = JSON.stringify(nova) !== JSON.stringify(faixaZoom);
    faixaZoom = nova;
    $("usar-zoom").disabled = !faixaZoom || faixaZoom[1] - faixaZoom[0] < TRECHO_MINIMO_S;
    $("usar-zoom").title = faixaZoom && faixaZoom[1] - faixaZoom[0] < TRECHO_MINIMO_S
      ? "O zoom precisa ter pelo menos 1 s para virar um trecho"
      : "Recalcula as métricas só para o trecho visível nos gráficos";
    if (mudou) desenharTrajeto();
    posicionarCursorGrafico();
  }

  function posicionarCursorGrafico() {
    const fl = gd._fullLayout;
    if (!graficoPronto || !fl || !fl.xaxis) { elCursor.hidden = true; return; }
    const xa = fl.xaxis;
    const [a, b] = xa.range;
    if (tCursor < a || tCursor > b) { elCursor.hidden = true; return; }
    const x = fl._size.l + xa.l2p(tCursor);
    elCursor.style.top = fl._size.t + "px";
    elCursor.style.height = fl._size.h + "px";
    elCursor.style.transform = "translateX(" + x.toFixed(1) + "px)";
    elCursor.hidden = false;
  }

  function tempoDoMouseNoGrafico(ev) {
    const fl = gd._fullLayout;
    if (!graficoPronto || !fl || !fl.xaxis) return null;
    const r = gd.getBoundingClientRect();
    const x = ev.clientX - r.left - fl._size.l;
    if (x < 0 || x > fl._size.w) return null;
    return fl.xaxis.p2l(x);
  }

  // ---------------------------------------------------------------------
  // Mapa (Leaflet)
  // ---------------------------------------------------------------------
  function iniciarMapa() {
    mapa = L.map("mapa", { preferCanvas: true, zoomSnap: 0.25 });
    const satelite = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19, attribution: "Imagens &copy; Esri, Maxar, Earthstar Geographics" });
    const ruas = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      { maxZoom: 19, attribution: "&copy; colaboradores do OpenStreetMap" });
    const relevo = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
      { maxZoom: 17, attribution: "&copy; OpenTopoMap (CC-BY-SA)" });
    satelite.addTo(mapa);
    L.control.layers({ "Satélite": satelite, "Ruas": ruas, "Relevo": relevo }, null,
      { position: "topright" }).addTo(mapa);
    L.control.scale({ imperial: false }).addTo(mapa);
    mapa.setView([0, 0], 2);

    camadaTrajeto = L.layerGroup().addTo(mapa);
    marcador = L.marker([0, 0], {
      icon: L.divIcon({ className: "aeronave", html: AVIAO_SVG, iconSize: [30, 30], iconAnchor: [15, 15] }),
      interactive: false,
      keyboard: false,
      zIndexOffset: 1000,
    });

    const container = mapa.getContainer();
    for (const ev of ["mousedown", "wheel", "touchstart"]) {
      container.addEventListener(ev, () => { mapaMexidoPeloUsuario = true; }, { passive: true });
    }
    mapa.on("mousemove", aoMoverNoMapa);
    mapa.on("click", aoMoverNoMapa);
    mapa.on("move zoomend moveend resize", () => { trajetoPx = null; });
  }

  function nivelNaEscala(v, min, max) {
    if (v === null || !isFinite(v)) return 0;
    if (max <= min) return 0;
    const k = Math.floor(((v - min) / (max - min)) * ESCALA.length);
    return Math.min(ESCALA.length - 1, Math.max(0, k));
  }

  function valoresParaCor() {
    const tr = P.trajeto;
    const metrica = $("cor-trajeto").value;
    if (metrica === "vel") return { valores: tr.vel, unidade: "m/s" };
    if (metrica === "alt") return { valores: tr.alt, unidade: "m" };
    if (metrica === "pot" && P.series.potencia) {
      return { valores: tr.t.map((t) => valorEm(P.series.potencia, t)), unidade: "W" };
    }
    return null;
  }

  function desenharTrajeto() {
    depuracao.trajeto++;
    camadaTrajeto.clearLayers();
    trajetoPx = null;
    const tr = P.trajeto;
    const temTrajeto = !!(tr && tr.t.length);
    $("mapa-vazio").hidden = temTrajeto;
    $("seguir").disabled = !temTrajeto;
    $("cor-trajeto").disabled = !temTrajeto;
    const link = $("link-gmaps");
    link.hidden = !temTrajeto;
    if (!temTrajeto) {
      marcador.remove();
      $("legenda").textContent = "";
      link.href = "#";
      ultimoLinkGmaps = "";
      return;
    }

    const cor = valoresParaCor();
    let min = Infinity, max = -Infinity;
    if (cor) {
      for (const v of cor.valores) {
        if (v !== null && isFinite(v)) { if (v < min) min = v; if (v > max) max = v; }
      }
    }

    // Agrupa segmentos consecutivos da mesma cor em uma linha só: poucas
    // camadas no mapa = desenho rápido mesmo com milhares de pontos.
    const grupos = ESCALA.map(() => []);
    const cinza = [];  // fora do zoom ou sem valor para colorir
    let atual = null, nivelAtual = null;
    for (let i = 0; i < tr.t.length - 1; i++) {
      // Ponto null = falha do GPS: o traço é interrompido ali.
      if (tr.lat[i] === null || tr.lat[i + 1] === null) { nivelAtual = null; continue; }
      const dentro = !faixaZoom || (tr.t[i + 1] >= faixaZoom[0] && tr.t[i] <= faixaZoom[1]);
      const v = cor ? cor.valores[i] : 0;
      const semValor = cor && (v === null || !isFinite(v));
      const nivel = !dentro || semValor ? -1 : (cor ? nivelNaEscala(v, min, max) : 0);
      if (nivel !== nivelAtual) {
        atual = [[tr.lat[i], tr.lng[i]]];
        (nivel === -1 ? cinza : grupos[nivel]).push(atual);
        nivelAtual = nivel;
      }
      atual.push([tr.lat[i + 1], tr.lng[i + 1]]);
    }
    if (cinza.length) {
      L.polyline(cinza, { color: "#9aa0a6", weight: 2, opacity: 0.55, interactive: false }).addTo(camadaTrajeto);
    }
    grupos.forEach((linhas, k) => {
      if (!linhas.length) return;
      L.polyline(linhas, {
        color: cor ? ESCALA[k] : COR_TRAJETO_UNICA, weight: 3.5, opacity: 0.95, interactive: false,
      }).addTo(camadaTrajeto);
    });
    const validos = pontosValidos();
    if (validos.length) {
      const i0 = validos[0], i1 = validos[validos.length - 1];
      L.circleMarker([tr.lat[i0], tr.lng[i0]], { radius: 5, color: "#000", weight: 1, fillColor: "#2ecc71", fillOpacity: 1 })
        .bindTooltip("Início do trecho").addTo(camadaTrajeto);
      L.circleMarker([tr.lat[i1], tr.lng[i1]], { radius: 5, color: "#000", weight: 1, fillColor: "#e74c3c", fillOpacity: 1 })
        .bindTooltip("Fim do trecho").addTo(camadaTrajeto);
    }

    const legenda = $("legenda");
    if (cor && isFinite(min)) {
      legenda.innerHTML = '<span></span><span class="barra-cor"></span><span></span>';
      legenda.children[0].textContent = fmt(min, 0);
      legenda.children[1].style.background = "linear-gradient(to right," + ESCALA.join(",") + ")";
      legenda.children[2].textContent = fmt(max, 0) + " " + cor.unidade;
    } else {
      legenda.textContent = "";
    }
    marcador.addTo(mapa);
  }

  // Índices dos pontos do trajeto com posição (sem as falhas do GPS).
  function pontosValidos() {
    const tr = P.trajeto, r = [];
    for (let i = 0; i < tr.t.length; i++) if (tr.lat[i] !== null && tr.lng[i] !== null) r.push(i);
    return r;
  }

  function ajustarMapaAoTrajeto() {
    const tr = P.trajeto;
    if (!tr || !tr.t.length) return;
    const tamanho = mapa.getSize();
    if (!tamanho.x || !tamanho.y) return;  // ainda sem tamanho; o ResizeObserver tenta de novo
    const validos = pontosValidos();
    if (!validos.length) return;
    const limites = L.latLngBounds(validos.map((i) => [tr.lat[i], tr.lng[i]]));
    mapa.fitBounds(limites, { padding: [24, 24], maxZoom: 18, animate: false });
  }

  function aoMoverNoMapa(ev) {
    if (!P || !P.trajeto || tocando) return;
    if (ev.originalEvent && ev.originalEvent.buttons) return;  // arrastando o mapa
    const tr = P.trajeto;
    if (!trajetoPx) {
      trajetoPx = tr.lat.map((la, i) => (la === null || tr.lng[i] === null)
        ? null : mapa.latLngToContainerPoint([la, tr.lng[i]]));
    }
    const p = ev.containerPoint;
    let melhor = -1, menor = 18 * 18;  // raio de captura: 18 px
    for (let i = 0; i < trajetoPx.length; i++) {
      if (!trajetoPx[i]) continue;
      if (faixaZoom && (tr.t[i] < faixaZoom[0] || tr.t[i] > faixaZoom[1])) continue;
      const dx = trajetoPx[i].x - p.x, dy = trajetoPx[i].y - p.y;
      const d = dx * dx + dy * dy;
      if (d < menor) { menor = d; melhor = i; }
    }
    // Origem "mapa": não recentraliza (o mapa andaria debaixo do mouse).
    if (melhor >= 0) definirCursor(tr.t[melhor], "mapa");
  }

  function atualizarMarcador() {
    if (!P.trajeto) return;
    const lat = valorEm(serieLat, tCursor);
    const lng = valorEm(serieLng, tCursor);
    const link = $("link-gmaps");
    if (lat === null || lng === null) {
      marcador.setOpacity(0);
      return;
    }
    marcador.setOpacity(1);
    marcador.setLatLng([lat, lng]);
    if (!svgAviao) svgAviao = marcador.getElement() && marcador.getElement().querySelector("svg");
    const rumo = serieRumo ? valorEm(serieRumo, tCursor, true) : null;
    if (svgAviao && rumo !== null) svgAviao.style.transform = "rotate(" + rumo.toFixed(0) + "deg)";

    const href = "https://www.google.com/maps/search/?api=1&query=" + lat.toFixed(7) + "," + lng.toFixed(7);
    if (href !== ultimoLinkGmaps) { link.href = href; ultimoLinkGmaps = href; }

    if ($("seguir").checked && origemCursor !== "mapa") {
      const ponto = L.latLng(lat, lng);
      if (!mapa.getBounds().pad(-0.25).contains(ponto)) mapa.panTo(ponto, { animate: false });
    }
  }

  // ---------------------------------------------------------------------
  // Cursor, quadro e reprodução
  // ---------------------------------------------------------------------
  function definirCursor(t, origem) {
    if (!P) return;
    origemCursor = origem || null;
    tCursor = Math.min(P.fim, Math.max(P.inicio, t));
    if (!quadroPendente) {
      quadroPendente = true;
      requestAnimationFrame(desenharQuadro);
    }
  }

  function desenharQuadro() {
    quadroPendente = false;
    if (!P) return;
    posicionarCursorGrafico();
    atualizarMarcador();
    atualizarCartoes();
    slider.value = String(tCursor);
    $("rotulo-tempo").textContent = fmtTempo(tCursor) + " / " + fmtTempo(P.fim);
  }

  function tocar() {
    if (!P) return;
    const [ini, fim] = faixaZoom || [P.inicio, P.fim];
    if (tCursor >= fim - 0.05 || tCursor < ini) tCursor = ini;
    tocando = true;
    $("play").textContent = "⏸";
    ultimoQuadro = performance.now();
    requestAnimationFrame(passoReproducao);
  }

  // Início do trecho visível (o zoom, se houver). Não pausa a reprodução.
  function irParaInicio() {
    if (!P) return;
    definirCursor(faixaZoom ? faixaZoom[0] : P.inicio);
  }

  function pausar() {
    tocando = false;
    $("play").textContent = "▶";
  }

  function passoReproducao(agora) {
    if (!tocando || !P) return;
    const dt = Math.min(0.25, (agora - ultimoQuadro) / 1000);
    ultimoQuadro = agora;
    const fim = faixaZoom ? faixaZoom[1] : P.fim;
    let t = tCursor + dt * Number($("velocidade").value);
    if (t >= fim) { t = fim; pausar(); }
    tCursor = t;
    origemCursor = null;
    desenharQuadro();
    if (tocando) requestAnimationFrame(passoReproducao);
  }

  // ---------------------------------------------------------------------
  // Construção a partir de um novo pacote de dados
  // ---------------------------------------------------------------------
  function construir(dados) {
    const anterior = P;
    P = dados;
    idAtual = dados.id;
    pausar();
    faixaZoom = null;
    $("usar-zoom").disabled = true;
    svgAviao = null;
    mapaMexidoPeloUsuario = false;

    const tr = P.trajeto;
    serieLat = tr ? { t: tr.t, y: tr.lat } : null;
    serieLng = tr ? { t: tr.t, y: tr.lng } : null;
    serieRumo = tr && tr.rumo ? { t: tr.t, y: tr.rumo } : null;

    slider.min = String(P.inicio);
    slider.max = String(P.fim);
    // Mantém o instante se ele continua dentro do novo trecho.
    if (!anterior || anterior.arquivo !== P.arquivo || tCursor < P.inicio || tCursor > P.fim) {
      tCursor = P.inicio;
    }

    // Mapa opcional: abas sem posição usam a largura toda para gráficos.
    const comMapa = P.mostrar_mapa !== false;
    document.querySelector(".mapa-box").hidden = !comMapa;
    document.querySelector(".principal").classList.toggle("sem-mapa", !comMapa);

    montarCartoes();
    desenharTrajeto();
    ajustarMapaAoTrajeto();
    montarGraficos().then(() => definirCursor(tCursor));
    definirCursor(tCursor);
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
    const escuro = tema.base === "dark";
    if (escuro !== temaEscuro) {
      temaEscuro = escuro;
      if (graficoPronto) montarGraficos();
    }
  }

  // ---------------------------------------------------------------------
  // Eventos
  // ---------------------------------------------------------------------
  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (!msg || msg.type !== "streamlit:render") return;
    aplicarTema(msg.theme);
    const dados = msg.args && msg.args.dados;
    // Streamlit reenvia os mesmos dados a cada interação na página; só
    // reconstruímos quando o trecho/arquivo realmente mudou.
    if (!dados || dados.id === idAtual) return;
    construir(dados);
  });

  $("graficos").parentElement.addEventListener("mousemove", (ev) => {
    if (tocando || ev.buttons) return;
    const t = tempoDoMouseNoGrafico(ev);
    if (t !== null) definirCursor(t);
  });

  slider.addEventListener("input", () => {
    pausar();
    definirCursor(Number(slider.value));
  });

  $("play").addEventListener("click", () => (tocando ? pausar() : tocar()));
  $("ir-inicio").addEventListener("click", irParaInicio);
  $("voltar").addEventListener("click", () => definirCursor(tCursor - 10));
  $("avancar").addEventListener("click", () => definirCursor(tCursor + 10));

  $("cor-trajeto").addEventListener("change", () => { if (P) desenharTrajeto(); });

  $("usar-zoom").addEventListener("click", () => {
    if (!faixaZoom || faixaZoom[1] - faixaZoom[0] < TRECHO_MINIMO_S) return;
    Streamlit.valor({
      acao: "janela",
      inicio: Math.round(faixaZoom[0] * 10) / 10,
      fim: Math.round(faixaZoom[1] * 10) / 10,
      nonce: Date.now(),
    });
  });

  document.addEventListener("keydown", (ev) => {
    if (!P || ev.target.tagName === "SELECT") return;
    if (ev.key === "Home") { ev.preventDefault(); irParaInicio(); return; }
    if (ev.code === "Space") {
      ev.preventDefault();
      tocando ? pausar() : tocar();
    } else if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
      if (ev.target === slider) return;  // o próprio slider já trata as setas
      ev.preventDefault();
      const passo = (ev.shiftKey ? 10 : 1) * (ev.key === "ArrowRight" ? 1 : -1);
      definirCursor(tCursor + passo);
    }
  });

  // Ajusta gráficos/mapa quando a largura muda e informa a altura ao Streamlit.
  // A altura do iframe acompanha o conteúdo; gráfico e mapa só são
  // redimensionados quando o tamanho DELES muda (evita redesenhos à toa).
  let ultimaAltura = 0;
  new ResizeObserver(() => {
    const h = Math.ceil($("app").getBoundingClientRect().height) + 6;
    if (h !== ultimaAltura) { ultimaAltura = h; Streamlit.altura(h); }
  }).observe($("app"));

  let tamanhoGrafico = "";
  new ResizeObserver(() => {
    const r = gd.getBoundingClientRect();
    const tamanho = Math.round(r.width) + "x" + Math.round(r.height);
    if (tamanho === tamanhoGrafico) return;
    tamanhoGrafico = tamanho;
    if (graficoPronto) {
      depuracao.redimensionamentos++;
      Plotly.Plots.resize(gd).then(posicionarCursorGrafico);
    }
  }).observe(gd);

  let tamanhoMapa = "";
  new ResizeObserver(() => {
    const r = $("mapa").getBoundingClientRect();
    const tamanho = Math.round(r.width) + "x" + Math.round(r.height);
    if (tamanho === tamanhoMapa || !mapa) return;
    tamanhoMapa = tamanho;
    mapa.invalidateSize({ animate: false });
    if (P && !mapaMexidoPeloUsuario) ajustarMapaAoTrajeto();
  }).observe($("mapa"));

  iniciarMapa();
  Streamlit.pronto();
})();
