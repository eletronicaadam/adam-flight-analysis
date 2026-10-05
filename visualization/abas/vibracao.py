"""
vibracao.py — aba Vibração: níveis de vibração no tempo (com os limites do
ArduPilot), comparação por fase (motor parado / motor ligado no solo / em
voo), espectro de frequências e espectrograma.
"""

import numpy as np
import pandas as pd
import plotly.graph_objects as go
import streamlit as st

import utils
from analysis import espectro
from analysis.eventos import detectar_voos
from visualization import dados_voo
from visualization.abas.comum import carregar_log_completo, linha_de_metricas, mostrar_painel

ATENCAO, CRITICO = 30.0, 60.0


def _fases(dados, origem, t):
    """Fase de cada instante: motor parado, motor ligado no solo, em voo."""
    fase = np.full(len(t), "Solo, motor parado", dtype=object)
    bat = dados.get("BAT")
    if bat is not None and "Curr" in bat.columns:
        bat = utils.filtrar_instancia(bat, "Inst")
        corrente = np.interp(t, dados_voo.segundos(bat, origem), np.nan_to_num(bat["Curr"].to_numpy(dtype=float)))
        fase[corrente > 3.0] = "Solo, motor ligado"
    for voo in detectar_voos(dados, origem):
        fase[(t >= voo["inicio_s"]) & (t <= voo["fim_s"])] = "Em movimento / voo"
    return fase


@st.cache_resource(max_entries=1, show_spinner=False)
def _lotes(caminho_str, versao):
    """Lotes do batch sampler do log (lidos uma vez por arquivo)."""
    completo = carregar_log_completo(caminho_str, versao)
    return espectro.lotes_batch_sampler(completo["dados"], completo["origem"])


@st.cache_data(max_entries=16, show_spinner=False)
def _preparar(caminho_str, versao, inicio, fim, fonte_espectro):
    completo = carregar_log_completo(caminho_str, versao)
    dados, origem = completo["dados"], completo["origem"]
    resultado = {"metricas": None, "fases": None, "espectro": None, "espectrograma": None, "painel": None}

    vibe = dados.get("VIBE")
    if vibe is not None and len(vibe):
        vibe = utils.filtrar_instancia(vibe, "IMU")
        t = dados_voo.segundos(vibe, origem)
        dentro = (t >= inicio) & (t <= fim)
        v = vibe[dentro]
        if len(v):
            eixos = v[["VibeX", "VibeY", "VibeZ"]]
            coluna_clip = "Clip" if "Clip" in v.columns else ("Clip0" if "Clip0" in v.columns else None)
            resultado["metricas"] = {
                "p99": eixos.quantile(0.99).to_dict(),
                "max": eixos.max().to_dict(),
                "clip": int(v[coluna_clip].max() - v[coluna_clip].min()) if coluna_clip else None,
            }
            fase = _fases(dados, origem, t[dentro])
            resultado["fases"] = pd.DataFrame({"fase": fase, "vibracao": eixos.max(axis=1).to_numpy()})

        linhas = [
            {"titulo": "Vibração (m/s²)", "series": [
                {"tipo": "VIBE", "campo": c, "nome": c, "unidade": "m/s²", "casas": 1} for c in ("VibeX", "VibeY", "VibeZ")
            ] + [
                {"t": [inicio, fim], "y": [ATENCAO, ATENCAO], "nome": "atenção (30)", "tracejado": True,
                 "cartao": False, "cor": "#ffa421"},
                {"t": [inicio, fim], "y": [CRITICO, CRITICO], "nome": "crítico (60)", "tracejado": True,
                 "cartao": False, "cor": "#ff4b4b"},
            ]},
        ]
        if "Clip" in vibe.columns:
            linhas.append({"titulo": "Clipping (contagem)", "series": [
                {"tipo": "VIBE", "campo": "Clip", "nome": "Clipping", "casas": 0}]})
        linhas.append({"titulo": "Acelerômetro (m/s²)", "series": [
            {"tipo": "IMU", "campo": c, "nome": c, "unidade": "m/s²", "casas": 2} for c in ("AccX", "AccY", "AccZ")]})
        resultado["painel"] = dados_voo.montar_painel_personalizado(dados, inicio, fim, linhas, mostrar_mapa=False)
        resultado["painel"]["id"] = f"vibracao|{caminho_str}|{versao}|{inicio}|{fim}"
        resultado["painel"]["arquivo"] = caminho_str

    # --- espectro ---
    lotes = _lotes(caminho_str, versao) if fonte_espectro == "batch" else None
    if lotes:
        e = espectro.espectro_batch(lotes, inicio, fim)
        if e:
            resultado["espectro"] = {"freq": e["freq"], "eixos": e["eixos"], "taxa": e["taxa"],
                                     "origem": f"batch sampler ({e['lotes']} lotes, {e['taxa']:.0f} Hz)"}
    else:
        amostras = espectro.amostras_imu(dados, origem, inicio, fim)
        if amostras is not None:
            t, acc, _, taxa = amostras
            eixos, freq = [], None
            for k in range(3):
                freq, amp = espectro.espectro_welch(acc[:, k], taxa)
                eixos.append(amp)
            resultado["espectro"] = {"freq": freq, "eixos": eixos, "taxa": taxa,
                                     "origem": f"mensagem IMU ({taxa:.0f} Hz)"}
            tc, fc, matriz = espectro.espectrograma(t, acc[:, 2], taxa)
            if len(tc):
                resultado["espectrograma"] = {"t": tc, "freq": fc, "db": matriz}
    return resultado


def mostrar_aba(ctx):
    ctx.completo()
    fonte = "imu"
    tem_batch = bool(_lotes(ctx.caminho_str, ctx.versao))
    if tem_batch:
        fonte = st.radio("Fonte do espectro", ["batch", "imu"], horizontal=True, key="vibracao_fonte",
                         format_func=lambda x: "Batch sampler (alta taxa)" if x == "batch" else "Mensagem IMU")
    r = _preparar(ctx.caminho_str, ctx.versao, ctx.inicio, ctx.fim, fonte)

    if r["metricas"] is None:
        st.info("Este log não tem mensagens de vibração (VIBE) neste trecho.")
        return
    m = r["metricas"]
    pior = max(m["p99"].values())
    situacao = "OK" if pior < ATENCAO else ("Atenção" if pior < CRITICO else "Crítico")
    linha_de_metricas([
        ("Situação (99% do tempo)", situacao, "Pelo percentil 99, para não contar picos isolados (toques, pouso)."),
        ("VibeX p99", f"{m['p99']['VibeX']:.1f} m/s²"),
        ("VibeY p99", f"{m['p99']['VibeY']:.1f} m/s²"),
        ("VibeZ p99", f"{m['p99']['VibeZ']:.1f} m/s²"),
        ("Pico (qualquer eixo)", f"{max(m['max'].values()):.1f} m/s²", "Picos isolados costumam ser toques/impacto."),
        ("Clipping no trecho", None if m["clip"] is None else str(m["clip"]),
         "Vezes que o acelerômetro saturou. Em voo deveria ser 0."),
    ])
    st.caption("Limites do ArduPilot: abaixo de 30 m/s² é bom; 30–60 pode atrapalhar a estimativa de "
               "posição/altitude; acima de 60 é crítico.")

    mostrar_painel(r["painel"], ctx, key="painel_vibracao")

    c1, c2 = st.columns(2)
    with c1:
        st.subheader("Vibração por fase")
        fases = r["fases"]
        fig = go.Figure()
        for nome in ("Solo, motor parado", "Solo, motor ligado", "Em movimento / voo"):
            valores = fases.loc[fases["fase"] == nome, "vibracao"]
            if len(valores):
                fig.add_trace(go.Box(y=valores, name=nome, boxpoints=False))
        fig.add_hline(y=ATENCAO, line_dash="dash", line_color="#ffa421")
        fig.update_layout(height=360, margin=dict(l=10, r=10, t=10, b=10), yaxis_title="maior eixo (m/s²)",
                          showlegend=False)
        st.plotly_chart(fig, width="stretch")
        st.caption("Se a vibração sobe muito de 'motor parado' para 'motor ligado', a fonte é o motor/hélice "
                   "(balanceamento, fixação, amortecimento da placa).")
    with c2:
        st.subheader("Espectro de frequências")
        e = r["espectro"]
        if e is None:
            st.info("Sem amostras suficientes para o espectro neste trecho.")
        else:
            fig = go.Figure()
            for nome, amp in zip(("X", "Y", "Z"), e["eixos"]):
                fig.add_trace(go.Scatter(x=e["freq"], y=amp, name=f"Acel. {nome}", mode="lines"))
            fig.update_layout(height=360, margin=dict(l=10, r=10, t=10, b=10), xaxis_title="frequência (Hz)",
                              yaxis_title="amplitude (m/s²)", legend=dict(orientation="h"))
            st.plotly_chart(fig, width="stretch")
            principais = espectro.picos(e["freq"], np.max(e["eixos"], axis=0))
            texto = ", ".join(f"{f:.1f} Hz" for f, _ in principais) or "nenhum pico claro"
            st.caption(f"Fonte: {e['origem']}. Picos principais: {texto}. Frequência máxima visível: "
                       f"{e['taxa'] / 2:.0f} Hz (metade da taxa de amostragem).")

    if r["espectrograma"] is not None:
        st.subheader("Espectrograma (acelerômetro Z ao longo do tempo)")
        g = r["espectrograma"]
        fig = go.Figure(go.Heatmap(x=g["t"], y=g["freq"], z=g["db"], colorscale="Viridis",
                                   colorbar=dict(title="dB")))
        fig.update_layout(height=320, margin=dict(l=10, r=10, t=10, b=10), xaxis_title="tempo (s)",
                          yaxis_title="frequência (Hz)")
        st.plotly_chart(fig, width="stretch")

    if not tem_batch:
        with st.expander("Como ver as frequências do motor e da hélice (batch sampler)"):
            st.markdown(
                "A mensagem IMU deste log foi gravada a baixa taxa, então o espectro só mostra até a metade "
                "dela (veja acima) — motor e hélice vibram bem acima disso. Para o próximo voo, ligue o "
                "**batch sampler** do ArduPilot, que grava a IMU em alta taxa em lotes:\n\n"
                "- `INS_LOG_BAT_MASK = 1` (grava a primeira IMU)\n"
                "- `INS_LOG_BAT_OPT = 0` (dados antes dos filtros; use 2 para ver depois dos filtros)\n"
                "- reinicie a controladora\n\n"
                "Esta aba detecta as mensagens ISBH/ISBD automaticamente e passa a usar esses dados no espectro."
            )
