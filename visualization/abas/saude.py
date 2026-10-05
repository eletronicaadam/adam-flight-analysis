"""
saude.py — aba Saúde do sistema: estimador de posição (EKF), processador,
gravação do log, qualidade do GPS, alimentação, sensores inerciais e
barômetro. Mostra um quadro "semáforo" por componente e os gráficos
sincronizados no tempo.
"""

import numpy as np
import pandas as pd
import streamlit as st

import utils
from visualization import dados_voo
from visualization.abas.comum import carregar_log_completo, mmss, mostrar_painel

# Limites usados no quadro (valor, explicação).
LIMITES = {
    "ekf_razao": (1.0, "razão de teste do EKF acima de 1 = medida rejeitada pelo estimador"),
    "ekf_frac_critica": (0.05, "mais de 5% do tempo com medidas rejeitadas"),
    "cpu_pct": (80.0, "carga da CPU acima de 80%"),
    "gps_hacc_m": (5.0, "precisão horizontal do GPS pior que 5 m"),
    "gps_vacc_m": (8.0, "precisão vertical do GPS pior que 8 m"),
    "vcc_min_v": (4.8, "alimentação da placa abaixo de 4,8 V"),
    "vcc_max_v": (5.4, "alimentação da placa acima de 5,4 V"),
}

ORDEM = {"Crítico": 0, "Atenção": 1, "OK": 2, "Sem dados": 3}
CORES = {"Crítico": "#ff4b4b55", "Atenção": "#ffa42155", "OK": "#21c35455", "Sem dados": "#80808033"}


def _no_trecho(dados, origem, tipo, inicio, fim, instancia=None):
    df = dados.get(tipo)
    if df is None or not len(df) or "TimeUS" not in df.columns:
        return None
    if instancia is not None:
        coluna = dados_voo.coluna_de_instancia(df)
        if coluna is not None:
            df = df[df[coluna] == instancia]
    t = dados_voo.segundos(df, origem)
    df = df[(t >= inicio) & (t <= fim)]
    return df if len(df) else None


def avaliar(dados, origem, inicio, fim):
    """Quadro de saúde: lista de {componente, situacao, detalhe}."""
    quadro = []

    def item(componente, situacao, detalhe):
        quadro.append({"Componente": componente, "Situação": situacao, "Detalhe": detalhe})

    # --- EKF ---
    xkf4 = _no_trecho(dados, origem, "XKF4", inicio, fim, instancia=0)
    if xkf4 is not None:
        razoes = [c for c in ("SV", "SP", "SH", "SM", "SVT") if c in xkf4.columns]
        valores = xkf4[razoes].to_numpy(dtype=np.float64)
        rejeitado = (valores > LIMITES["ekf_razao"][0]).any(axis=1)
        frac = float(rejeitado.mean())
        piores = {c: round(float(xkf4[c].max()), 2) for c in razoes}
        nomes = {"SV": "velocidade", "SP": "posição", "SH": "altura", "SM": "bússola", "SVT": "airspeed"}
        detalhe = f"{frac * 100:.1f}% do tempo com medida rejeitada. Máximos: " + \
                  ", ".join(f"{nomes.get(c, c)} {v}" for c, v in piores.items())
        situacao = "OK" if frac == 0 else ("Crítico" if frac >= LIMITES["ekf_frac_critica"][0] else "Atenção")
        extras = []
        if "FS" in xkf4.columns and (xkf4["FS"] != 0).any():
            extras.append("falhas internas do filtro (FS≠0)")
            situacao = "Atenção" if situacao == "OK" else situacao
        if "TS" in xkf4.columns and (xkf4["TS"] != 0).any():
            extras.append("timeouts de sensores (TS≠0)")
            situacao = "Atenção" if situacao == "OK" else situacao
        item("Estimador de posição (EKF)", situacao, detalhe + (" · " + ", ".join(extras) if extras else ""))
    else:
        item("Estimador de posição (EKF)", "Sem dados", "Log sem XKF4 neste trecho.")

    msg = _no_trecho(dados, origem, "MSG", inicio, fim)
    if msg is not None:
        ekf = msg["Message"].astype(str).str.contains("EKF", case=False)
        if ekf.sum() > 10:
            item("Mensagens do EKF", "Atenção", f"{int(ekf.sum())} mensagens do EKF no trecho "
                 "(realinhamentos/resets repetidos indicam conflito entre sensores).")

    # --- CPU / memória ---
    pm = _no_trecho(dados, origem, "PM", inicio, fim)
    if pm is not None:
        carga = pm["Load"].to_numpy(dtype=np.float64) * 0.1 if "Load" in pm.columns else np.array([np.nan])
        longos = int(pm["NLon"].sum()) if "NLon" in pm.columns else 0
        periodo_us = 1e6 / float(pm["LR"].median()) if "LR" in pm.columns and pm["LR"].median() > 0 else None
        pior_loop = float(pm["MaxT"].max()) if "MaxT" in pm.columns else None
        situacao = "OK"
        if np.nanmax(carga) > LIMITES["cpu_pct"][0]:
            situacao = "Atenção"
        detalhe = f"Carga máx. {np.nanmax(carga):.0f}% (média {np.nanmean(carga):.0f}%)"
        if periodo_us and pior_loop:
            detalhe += f" · loop mais lento {pior_loop / 1000:.1f} ms (período {periodo_us / 1000:.1f} ms)"
        if longos:
            detalhe += f" · {longos} loops longos"
        if "Mem" in pm.columns:
            detalhe += f" · memória livre mín. {pm['Mem'].min() / 1024:.0f} kB"
            if pm["Mem"].min() < 4096:
                situacao = "Atenção"
        item("Processador", situacao, detalhe)
    else:
        item("Processador", "Sem dados", "Log sem PM neste trecho.")

    # --- Gravação do log ---
    dsf = _no_trecho(dados, origem, "DSF", inicio, fim)
    if dsf is not None and "Dp" in dsf.columns:
        perdidas = int(dsf["Dp"].max() - dsf["Dp"].min())
        item("Gravação do log", "Atenção" if perdidas else "OK",
             f"{perdidas} mensagens perdidas no trecho" + (f" · buffer livre mín. {dsf['FMn'].min() / 1024:.0f} kB"
                                                           if "FMn" in dsf.columns else ""))

    # --- GPS ---
    gps = _no_trecho(dados, origem, "GPS", inicio, fim, instancia=0)
    gpa = _no_trecho(dados, origem, "GPA", inicio, fim, instancia=0)
    if gps is not None:
        com_fix = gps[gps["Status"] >= 3]
        situacao, partes = "OK", []
        if len(com_fix) < len(gps):
            partes.append(f"{(1 - len(com_fix) / len(gps)) * 100:.0f}% do tempo sem fix 3D")
            situacao = "Atenção"
        if len(com_fix):
            partes.append(f"satélites mín. {int(com_fix['NSats'].min())}, HDop máx. {com_fix['HDop'].max():.1f}")
        if gpa is not None:
            validos = gpa[(gpa["HAcc"] < 600) & (gpa["VAcc"] < 600)]
            if len(validos):
                hacc, vacc = float(validos["HAcc"].quantile(0.95)), float(validos["VAcc"].quantile(0.95))
                partes.append(f"precisão (95%): horizontal {hacc:.1f} m, vertical {vacc:.1f} m")
                if hacc > LIMITES["gps_hacc_m"][0] or vacc > LIMITES["gps_vacc_m"][0]:
                    situacao = "Atenção"
        item("GPS", situacao, " · ".join(partes))
    else:
        item("GPS", "Sem dados", "Log sem GPS neste trecho.")

    # --- Alimentação ---
    powr = _no_trecho(dados, origem, "POWR", inicio, fim)
    if powr is not None and "Vcc" in powr.columns and np.isfinite(powr["Vcc"]).any():
        vcc = powr["Vcc"].astype(float)
        fora = vcc.min() < LIMITES["vcc_min_v"][0] or vcc.max() > LIMITES["vcc_max_v"][0]
        detalhe = f"Vcc {vcc.min():.2f}–{vcc.max():.2f} V"
        if "VServo" in powr.columns and np.isfinite(powr["VServo"]).any():
            detalhe += f" · trilho dos servos {powr['VServo'].min():.2f}–{powr['VServo'].max():.2f} V"
        item("Alimentação da placa", "Atenção" if fora else "OK", detalhe)
    else:
        item("Alimentação da placa", "Sem dados", "Esta placa não mede a própria tensão (POWR.Vcc vazio).")

    # --- Sensores inerciais ---
    imu = _no_trecho(dados, origem, "IMU", inicio, fim, instancia=0)
    if imu is not None:
        situacao, partes = "OK", []
        for coluna, nome in (("EG", "erros do giroscópio"), ("EA", "erros do acelerômetro")):
            if coluna in imu.columns and imu[coluna].max() > imu[coluna].min():
                partes.append(f"{int(imu[coluna].max() - imu[coluna].min())} {nome}")
                situacao = "Atenção"
        for coluna, nome in (("GH", "giroscópio"), ("AH", "acelerômetro")):
            if coluna in imu.columns and (imu[coluna] == 0).any():
                partes.append(f"{nome} reportou falha de saúde")
                situacao = "Atenção"
        if "T" in imu.columns:
            partes.append(f"temperatura {imu['T'].min():.0f}–{imu['T'].max():.0f} °C")
        item("Sensores inerciais (IMU)", situacao, " · ".join(partes) or "sem erros")

    # --- Barômetro ---
    baro = _no_trecho(dados, origem, "BARO", inicio, fim, instancia=0)
    if baro is not None:
        situacao, partes = "OK", []
        if "H" in baro.columns and (baro["H"] == 0).any():
            partes.append("barômetro reportou falha de saúde")
            situacao = "Atenção"
        div = dados_voo.divergencia_altitude(dados_voo.cortar_janela(dados, inicio, fim, origem), origem,
                                             dados_voo.referencias_altitude(dados))
        if div and div["p95_m"] > dados_voo.DIVERGENCIA_ALTITUDE_M:
            partes.append(f"discorda do GPS em até {div['max_m']:.0f} m em voo (provável fluxo de ar no sensor)")
            situacao = "Atenção"
        if "Temp" in baro.columns:
            partes.append(f"temperatura da placa {baro['Temp'].min():.0f}–{baro['Temp'].max():.0f} °C")
        item("Barômetro", situacao, " · ".join(partes))

    # --- Bússola ---
    if "MAG" in dados:
        item("Bússola", "OK", "Bússola registrada no log.")
    else:
        prearm = msg is not None and msg["Message"].astype(str).str.contains("Compass", case=False).any()
        item("Bússola", "Atenção" if prearm else "Sem dados",
             "Bússola não registrada" + (" e com aviso 'Compass not healthy'." if prearm else "."))

    return sorted(quadro, key=lambda x: ORDEM[x["Situação"]])


@st.cache_data(max_entries=16, show_spinner=False)
def _preparar(caminho_str, versao, inicio, fim):
    completo = carregar_log_completo(caminho_str, versao)
    dados, origem, un = completo["dados"], completo["origem"], completo["unidades"]
    quadro = avaliar(dados, origem, inicio, fim)

    def campo(tipo, nome_campo, rotulo, casas=2, instancia=0):
        unidade, fator = un.get(tipo, {}).get(nome_campo, ("", 1.0))
        return {"tipo": tipo, "campo": nome_campo, "nome": rotulo, "unidade": unidade, "fator": fator,
                "casas": casas, "instancia": instancia}

    def limite(valor, rotulo):
        return {"t": [inicio, fim], "y": [valor, valor], "nome": rotulo, "tracejado": True, "cartao": False,
                "cor": "#ff4b4b"}

    linhas = [
        {"titulo": "EKF: razões de teste (>1 = rejeitada)", "series": [
            campo("XKF4", "SV", "EKF velocidade"), campo("XKF4", "SP", "EKF posição"),
            campo("XKF4", "SH", "EKF altura"), campo("XKF4", "SM", "EKF bússola"), limite(1.0, "limite")]},
        {"titulo": "CPU (%)", "series": [campo("PM", "Load", "Carga da CPU", 1)]},
        {"titulo": "Loop mais lento (µs)", "series": [campo("PM", "MaxT", "Loop mais lento", 0)]},
    ]
    gpa = dados.get("GPA")
    if gpa is not None and len(gpa):
        gpa = utils.filtrar_instancia(gpa, "I")
        t = dados_voo.segundos(gpa, origem)
        # 655,35 m = "sem estimativa" (antes do fix): vira lacuna.
        hacc = np.where(gpa["HAcc"] < 600, gpa["HAcc"], np.nan)
        vacc = np.where(gpa["VAcc"] < 600, gpa["VAcc"], np.nan)
        linhas.append({"titulo": "Precisão do GPS (m)", "series": [
            {"t": t, "y": hacc, "nome": "GPS precisão horizontal", "unidade": "m", "casas": 1},
            {"t": t, "y": vacc, "nome": "GPS precisão vertical", "unidade": "m", "casas": 1}]})
    linhas.append({"titulo": "Satélites do GPS", "series": [campo("GPS", "NSats", "Satélites", 0)]})
    linhas.append({"titulo": "HDop do GPS (menor = melhor; > 2 ruim)", "series": [campo("GPS", "HDop", "HDop", 2)]})
    linhas.append({"titulo": "Temperatura (°C)", "series": [
        campo("IMU", "T", "Temp. IMU", 1), campo("BARO", "Temp", "Temp. barômetro", 1)]})
    powr = dados.get("POWR")
    if powr is not None and "Vcc" in powr.columns and np.isfinite(powr["Vcc"]).any():
        linhas.append({"titulo": "Alimentação (V)", "series": [
            campo("POWR", "Vcc", "Vcc da placa"), campo("POWR", "VServo", "Trilho dos servos")]})

    painel = dados_voo.montar_painel_personalizado(dados, inicio, fim, linhas, mostrar_mapa=False)
    painel["id"] = f"saude|{caminho_str}|{versao}|{inicio}|{fim}"
    painel["arquivo"] = caminho_str

    mensagens = None
    msg = _no_trecho(dados, origem, "MSG", inicio, fim)
    if msg is not None:
        t = dados_voo.segundos(msg, origem)
        mensagens = pd.DataFrame({"instante": [mmss(x) for x in t], "mensagem": msg["Message"].astype(str)})
    return quadro, painel, mensagens


def mostrar_aba(ctx):
    ctx.completo()
    quadro, painel, mensagens = _preparar(ctx.caminho_str, ctx.versao, ctx.inicio, ctx.fim)

    st.subheader("Quadro de saúde do trecho")
    tabela = pd.DataFrame(quadro)
    st.dataframe(
        tabela.style.map(lambda s: f"background-color: {CORES.get(s, '')}", subset=["Situação"]),
        hide_index=True, width="stretch",
    )
    with st.expander("Como ler este quadro"):
        st.markdown("\n".join(f"- **{k}**: {v[1]} (limite {v[0]})" for k, v in LIMITES.items()))
        st.markdown("- Se a controladora estiver montada ao contrário ou sem calibração, o EKF fica instável "
                    "(medidas rejeitadas e realinhamentos) — corrija a instalação antes de confiar nele.")

    mostrar_painel(painel, ctx, key="painel_saude")

    if mensagens is not None:
        with st.expander(f"Mensagens do firmware no trecho ({len(mensagens)})"):
            filtro = st.text_input("Filtrar texto", key="saude_busca_msg", placeholder="ex.: EKF, failsafe, PreArm")
            if filtro:
                mensagens = mensagens[mensagens["mensagem"].str.contains(filtro, case=False, na=False)]
            st.dataframe(mensagens, hide_index=True, width="stretch", height=300)
