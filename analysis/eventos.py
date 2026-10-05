"""
eventos.py

Detecta eventos de segurança em um log: problemas de bateria, vibração,
GPS, controle, atitude, mensagens do firmware e falhas de configuração
(placa ao contrário, barômetro contaminado...). Cada evento traz instante,
gravidade, evidência numérica e de onde veio, para que qualquer conclusão
possa ser conferida no log.

Todos os limites ficam em LIMITES, cada um com a sua fonte: para mudar um
critério, mude só ali.

Uso:
    from analysis import eventos
    resultado = eventos.detectar(dados, ficha)
    resultado["eventos"]   # lista ordenada por instante
"""

import re

import numpy as np

import utils
from analysis import atitude as atitude_mod
from analysis.ficha import controladora_comanda
from visualization import dados_voo as dv

# (valor, fonte/justificativa)
LIMITES = {
    "vibracao_atencao_ms2": (30.0, "ArduPilot: vibração acima de 30 m/s² prejudica a estimativa de posição/altitude"),
    "vibracao_critica_ms2": (60.0, "ArduPilot: acima de 60 m/s² o estimador pode falhar"),
    "vibracao_duracao_s": (1.0, "ignora picos isolados (toques, pouso)"),
    "clip_aumento": (1, "ArduPilot: qualquer clipping em voo indica acelerômetro saturado"),
    "celula_minima_v": (3.3, "ficha da aeronave (bateria.tensao_minima_celula_v)"),
    "queda_celula_atencao_v": (0.6, "queda sob carga acima de ~0,6 V/célula indica bateria cansada ou subdimensionada"),
    "corrente_duracao_s": (0.5, "corrente acima do limite por mais que isso"),
    "hdop_max": (2.0, "HDop acima de 2 = precisão horizontal ruim"),
    "satelites_min": (6, "menos de 6 satélites = posição pouco confiável"),
    "gps_salto_ms": (60.0, "salto de posição mais rápido que isso é erro de GPS"),
    "controle_erro_graus": (10.0, "atitude real longe da pedida pelo piloto automático"),
    "controle_duracao_s": (1.0, "erro de controle sustentado"),
    "roll_extremo_graus": (60.0, "inclinação lateral acima disso é manobra extrema para este tipo de avião"),
    "pitch_extremo_graus": (30.0, "pitch acima de ±30° é atitude extrema"),
    "angulo_ataque_alto_graus": (15.0, "pitch menos ângulo da trajetória acima disso: perto do estol na maioria dos perfis"),
    "angulo_ataque_duracao_s": (2.0, "sustentado"),
    "descida_ingreme_graus": (-15.0, "trajetória mais inclinada que isso para baixo"),
    "descida_ingreme_duracao_s": (1.0, "sustentada"),
    "impacto_desaceleracao_ms2": (5.0, "parada mais brusca que isso no fim do voo não é pouso normal"),
    "divergencia_altitude_m": (5.0, "barômetro e GPS discordando mais que isso em voo"),
    "velocidade_voo_ms": (3.0, "acima disso o avião está em movimento (corrida ou voo)"),
}

GRAVIDADES = ("critico", "atencao", "info")


def _lim(nome):
    return LIMITES[nome][0]


def _evento(lista, codigo, categoria, gravidade, inicio, fim, titulo, descricao,
            evidencia=None, fonte="", confianca="alta"):
    lista.append({
        "codigo": codigo,
        "categoria": categoria,
        "gravidade": gravidade,
        "inicio_s": None if inicio is None else round(float(inicio), 2),
        "fim_s": None if fim is None else round(float(fim), 2),
        "titulo": titulo,
        "descricao": descricao,
        "evidencia": evidencia or {},
        "fonte": fonte,
        "confianca": confianca,
    })


def _intervalos(t, mascara, duracao_min=0.0, juntar_s=1.0):
    """Trechos contínuos em que `mascara` é verdadeira: lista de (ini, fim, idx)."""
    idx = np.nonzero(mascara)[0]
    if not len(idx):
        return []
    trechos, comeco, anterior = [], idx[0], idx[0]
    for i in idx[1:]:
        if t[i] - t[anterior] > juntar_s:
            trechos.append((comeco, anterior))
            comeco = i
        anterior = i
    trechos.append((comeco, anterior))
    return [(t[a], t[b], np.arange(a, b + 1)) for a, b in trechos if t[b] - t[a] >= duracao_min]


def _em_voo(t, voos, impactos=()):
    """Máscara de instantes em voo, sem as janelas de impacto (se dadas)."""
    m = np.zeros(len(t), dtype=bool)
    for v in voos:
        m |= (t >= v["inicio_s"]) & (t <= v["fim_s"])
    for ini, fim in impactos:
        m &= ~((t >= ini - 0.5) & (t <= fim + 1.0))
    return m


def _janelas_de_impacto(eventos):
    return [(e["inicio_s"], e["fim_s"]) for e in eventos if e["codigo"] == "impacto"]


def _mmss(s):
    m, r = divmod(max(0.0, float(s)), 60)
    return f"{int(m)}:{r:04.1f}"


# -----------------------------------------------------------------------
# Fases do voo
# -----------------------------------------------------------------------
def detectar_voos(dados, origem):
    """
    Trechos em movimento (velocidade GPS acima do limite por pelo menos
    3 s). Cada um com decolagem, fim e se terminou de forma abrupta.
    """
    gps = dv.gps_valido(dados)
    if gps is None:
        return []
    t = dv.segundos(gps, origem)
    vel = gps["Spd"].to_numpy(dtype=np.float64)
    rapido = vel > _lim("velocidade_voo_ms")
    trechos = []
    for ini, fim, idx in _intervalos(t, rapido, duracao_min=3.0, juntar_s=3.0):
        # Sem nenhuma leitura de GPS válida entre dois trechos = o GPS perdeu
        # o fix em voo (e não um pouso): junta os dois num voo só.
        if trechos and not ((t > trechos[-1][1]) & (t < ini)).any():
            trechos[-1] = (trechos[-1][0], fim, np.r_[trechos[-1][2], idx])
        else:
            trechos.append((ini, fim, idx))
    return [{
        "inicio_s": round(float(ini), 2),
        "fim_s": round(float(fim), 2),
        "duracao_s": round(float(fim - ini), 1),
        "velocidade_max_ms": round(float(vel[idx].max()), 1),
    } for ini, fim, idx in trechos]


def _fim_do_voo(eventos, dados, origem, voo, atitude):
    """Classifica o fim de um voo: pouso normal ou parada brusca (impacto)."""
    gps = dv.gps_valido(dados)
    t = dv.segundos(gps, origem)
    vel = gps["Spd"].to_numpy(dtype=np.float64)
    perto = (t >= voo["fim_s"] - 3) & (t <= voo["fim_s"] + 3)
    if perto.sum() < 3:
        return
    tt, vv = t[perto], vel[perto]
    i_max = int(np.argmax(vv))
    depois = np.nonzero((tt > tt[i_max]) & (vv < 2.0))[0]
    if not len(depois):
        return
    j = depois[0]
    desaceleracao = (vv[i_max] - vv[j]) / max(tt[j] - tt[i_max], 1e-3)
    evid = {
        "velocidade_antes_ms": round(float(vv[i_max]), 1),
        "tempo_ate_parar_s": round(float(tt[j] - tt[i_max]), 2),
        "desaceleracao_ms2": round(float(desaceleracao), 1),
    }
    bat = dados.get("BAT")
    if bat is not None and "Curr" in bat.columns:
        bat = utils.filtrar_instancia(bat, "Inst")
        tb = dv.segundos(bat, origem)
        janela = (tb >= tt[i_max] - 1) & (tb <= tt[j] + 1)
        antes = (tb >= tt[i_max] - 5) & (tb < tt[i_max] - 1)
        if janela.any():
            evid["pico_corrente_a"] = round(float(np.nanmax(bat["Curr"].to_numpy()[janela])), 1)
        if antes.any():
            evid["corrente_antes_a"] = round(float(np.nanmedian(bat["Curr"].to_numpy()[antes])), 1)
    imu = dados.get("IMU")
    if imu is not None and len(imu):
        imu = utils.filtrar_instancia(imu, "I")
        ti = dv.segundos(imu, origem)
        janela = (ti >= tt[i_max] - 1) & (ti <= tt[j] + 1)
        if janela.any():
            norma = np.linalg.norm(imu[["AccX", "AccY", "AccZ"]].to_numpy()[janela], axis=1)
            evid["pico_aceleracao_g"] = round(float(norma.max() / 9.81), 1)
    if atitude is not None:
        final = (atitude["t"] > tt[j] + 1) & (atitude["t"] < tt[j] + 4)
        if final.any():
            evid["pitch_apos_parar_graus"] = round(float(atitude["Pitch"][final].median()), 0)
            evid["roll_apos_parar_graus"] = round(float(atitude["Roll"][final].median()), 0)

    if desaceleracao > _lim("impacto_desaceleracao_ms2"):
        _evento(eventos, "impacto", "Fases do voo", "critico", tt[i_max], tt[j],
                "Fim abrupto do voo (provável impacto)",
                f"A velocidade caiu de {vv[i_max]:.0f} m/s para quase zero em {tt[j] - tt[i_max]:.1f} s "
                f"({desaceleracao:.0f} m/s²) — muito mais brusco que um pouso.",
                evid, "GPS.Spd, BAT.Curr, IMU")
    else:
        _evento(eventos, "pouso", "Fases do voo", "info", tt[i_max], tt[j], "Fim do voo / pouso",
                f"Parada a partir de {vv[i_max]:.0f} m/s em {tt[j] - tt[i_max]:.1f} s.", evid, "GPS.Spd")


# -----------------------------------------------------------------------
# Detectores
# -----------------------------------------------------------------------
def _resistencia_interna(t, volt, corr, inicio_voo):
    """
    Resistência interna do pack (Ω) medida no degrau de aceleração do
    motor antes da decolagem: ΔV/ΔI entre logo antes e logo depois de a
    corrente subir. Durante o voo a corrente fica quase constante e a
    tensão cai pela descarga, o que estragaria uma regressão simples.
    Devolve None se não houver degrau claro (> 10 A).
    """
    perto = (t > inicio_voo - 30) & (t < inicio_voo + 10) & np.isfinite(corr)
    if perto.sum() < 10:
        return None
    tt, cc, vv = t[perto], corr[perto], volt[perto]
    alvo = 0.5 * np.percentile(cc, 95)
    subida = np.nonzero(cc > alvo)[0]
    if not len(subida) or alvo < 5:
        return None
    t_degrau = tt[subida[0]]
    antes = (tt > t_degrau - 3) & (tt < t_degrau - 0.5)
    depois = (tt > t_degrau + 0.5) & (tt < t_degrau + 3)
    if antes.sum() < 2 or depois.sum() < 2:
        return None
    delta_i = np.median(cc[depois]) - np.median(cc[antes])
    if delta_i < 10:
        return None
    return round(float((np.median(vv[antes]) - np.median(vv[depois])) / delta_i), 3)


def _bateria(eventos, dados, origem, ficha, voos, impactos=()):
    bat = dados.get("BAT")
    if bat is None or not len(bat):
        return {}
    bat = utils.filtrar_instancia(bat, "Inst")
    if not len(bat):
        return {}
    t = dv.segundos(bat, origem)
    volt = bat["Volt"].to_numpy(dtype=np.float64)
    corr = bat["Curr"].to_numpy(dtype=np.float64) if "Curr" in bat.columns else np.full(len(t), np.nan)

    celulas = ficha["bateria"].get("celulas")
    origem_celulas = "ficha"
    if not celulas:
        celulas = max(1, int(round(np.nanmax(volt) / 4.2)))
        origem_celulas = "estimado pela tensão máxima"
    info = {"celulas": celulas, "celulas_fonte": origem_celulas}
    em_voo = _em_voo(t, voos)

    minimo = ficha["bateria"].get("tensao_minima_celula_v") or _lim("celula_minima_v")
    for ini, fim, idx in _intervalos(t, volt / celulas < minimo, duracao_min=1.0):
        grav = "critico" if em_voo[idx].any() else "atencao"
        _evento(eventos, "bateria_celula_baixa", "Bateria", grav, ini, fim,
                f"Tensão abaixo de {minimo:.2f} V por célula",
                f"Mínimo de {np.nanmin(volt[idx]) / celulas:.2f} V/célula ({np.nanmin(volt[idx]):.2f} V, {celulas}S).",
                {"tensao_min_v": round(float(np.nanmin(volt[idx])), 2), "celulas": celulas}, "BAT.Volt")

    if voos and np.isfinite(corr).any():
        primeiro = voos[0]["inicio_s"]
        repouso = (t > primeiro - 30) & (t < primeiro - 2) & (np.nan_to_num(corr) < 3)
        # Sem o instante do impacto (pico de corrente da hélice batendo).
        voando = _em_voo(t, voos, impactos) & np.isfinite(corr)
        if repouso.sum() >= 3 and voando.sum() >= 10:
            v_rep = float(np.median(volt[repouso]))
            # Tensão sob carga sustentada: percentil 2 (ignora picos isolados).
            v_min = float(np.percentile(volt[voando], 2))
            queda = (v_rep - v_min) / celulas
            info.update({
                "tensao_repouso_v": round(v_rep, 2), "tensao_min_voo_v": round(v_min, 2),
                "queda_por_celula_v": round(queda, 2),
                "corrente_media_voo_a": round(float(np.mean(corr[voando])), 1),
                "resistencia_interna_ohm": _resistencia_interna(t, volt, corr, voos[0]["inicio_s"]),
            })
            gravidade = "atencao" if queda > _lim("queda_celula_atencao_v") else "info"
            i_min = np.nonzero(voando)[0][np.argmin(np.abs(volt[voando] - v_min))]
            _evento(eventos, "bateria_queda_sob_carga", "Bateria", gravidade, t[i_min], t[i_min],
                    "Queda de tensão sob carga",
                    f"De {v_rep:.2f} V em repouso para {v_min:.2f} V em voo: {queda:.2f} V por célula "
                    f"com ~{np.mean(corr[voando]):.0f} A.",
                    {k: info[k] for k in ("tensao_repouso_v", "tensao_min_voo_v", "queda_por_celula_v",
                                          "corrente_media_voo_a", "resistencia_interna_ohm")},
                    "BAT.Volt, BAT.Curr")

    limite = ficha["propulsao"].get("corrente_maxima_a")
    if limite and np.isfinite(corr).any():
        for ini, fim, idx in _intervalos(t, np.nan_to_num(corr) > limite, duracao_min=_lim("corrente_duracao_s")):
            _evento(eventos, "corrente_acima_limite", "Bateria", "atencao", ini, fim,
                    f"Corrente acima do limite de {limite:.0f} A",
                    f"Pico de {np.nanmax(corr[idx]):.0f} A por {fim - ini:.1f} s.",
                    {"pico_a": round(float(np.nanmax(corr[idx])), 1)}, "BAT.Curr")
    return info


def _vibracao(eventos, dados, origem, voos, impactos=()):
    vibe = dados.get("VIBE")
    if vibe is None or not len(vibe):
        return
    vibe = utils.filtrar_instancia(vibe, "IMU")
    t = dv.segundos(vibe, origem)
    # Vibração e clipping no impacto são consequência da batida, não do voo.
    em_voo = _em_voo(t, voos, impactos)
    maximo = vibe[["VibeX", "VibeY", "VibeZ"]].to_numpy(dtype=np.float64).max(axis=1)
    # Um evento por intervalo acima do limite de atenção, com a gravidade do
    # pior trecho (antes saíam dois eventos sobrepostos, 30 e 60).
    atencao, critica = _lim("vibracao_atencao_ms2"), _lim("vibracao_critica_ms2")
    dt = np.diff(t, append=t[-1]) if len(t) else t
    for ini, fim, idx in _intervalos(t, (maximo > atencao) & em_voo, duracao_min=_lim("vibracao_duracao_s"),
                                     juntar_s=2.0):
        eixos = vibe.iloc[idx][["VibeX", "VibeY", "VibeZ"]].max()
        acima_critico = float(dt[idx][maximo[idx] > critica].sum())
        gravidade = "critico" if acima_critico >= _lim("vibracao_duracao_s") else "atencao"
        evid = {k: round(float(v), 1) for k, v in eixos.items()}
        evid.update({"segundos_acima_atencao": round(float(fim - ini), 1),
                     "segundos_acima_critico": round(acima_critico, 1)})
        _evento(eventos, "vibracao_alta", "Vibração", gravidade, ini, fim,
                f"Vibração acima de {critica if gravidade == 'critico' else atencao:.0f} m/s²",
                f"Máximo de {eixos.max():.0f} m/s² (eixo {eixos.idxmax()[-1]}) em {fim - ini:.1f} s acima de "
                f"{atencao:.0f} m/s², dos quais {acima_critico:.1f} s acima de {critica:.0f} m/s².",
                evid, "VIBE")
    coluna = "Clip" if "Clip" in vibe.columns else ("Clip0" if "Clip0" in vibe.columns else None)
    if impactos:
        no_impacto = _em_voo(t, voos) & ~em_voo
        if no_impacto.any():
            pico = float(maximo[no_impacto].max())
            clip_imp = vibe[coluna].to_numpy()[no_impacto] if coluna else None
            if pico > _lim("vibracao_atencao_ms2"):
                _evento(eventos, "vibracao_impacto", "Vibração", "info", t[no_impacto][0], t[no_impacto][-1],
                        "Pico de vibração no impacto",
                        f"{pico:.0f} m/s²" + (f" e {int(clip_imp.max() - clip_imp.min())} clippings" if clip_imp is not None else "")
                        + " no momento da batida — consequência do impacto, não um problema do voo.",
                        {"pico_ms2": round(pico, 1)}, "VIBE")
    if em_voo.any():
        p99 = float(np.percentile(maximo[em_voo], 99))
        if p99 <= _lim("vibracao_atencao_ms2"):
            _evento(eventos, "vibracao_ok", "Vibração", "info", t[em_voo][0], t[em_voo][-1], "Vibração em voo normal",
                    f"99% das leituras em voo abaixo de {p99:.0f} m/s² (limite {_lim('vibracao_atencao_ms2'):.0f}).",
                    {"p99_ms2": round(p99, 1)}, "VIBE")
    if coluna and em_voo.any():
        clip = vibe[coluna].to_numpy().astype(np.float64)
        # Soma só os aumentos entre leituras consecutivas em voo (o contador
        # é cumulativo: max-min global contaria saturações no solo entre voos).
        subida = np.diff(clip, prepend=clip[0])
        valido = em_voo & np.r_[False, em_voo[:-1]] & (subida > 0)
        aumento = int(subida[valido].sum())
        if aumento >= _lim("clip_aumento"):
            primeiro = t[np.argmax(valido)]
            _evento(eventos, "clipping", "Vibração", "atencao", primeiro, t[em_voo][-1],
                    "Acelerômetro saturou (clipping)",
                    f"O contador de clipping subiu {aumento} vezes durante o voo.",
                    {"aumento": aumento}, f"VIBE.{coluna}")


def _gps(eventos, dados, origem, voos):
    gps = dados.get("GPS")
    if gps is None or not len(gps):
        return
    gps = utils.filtrar_instancia(gps, "I")
    t = dv.segundos(gps, origem)
    em_voo = _em_voo(t, voos)
    status = gps["Status"].to_numpy()
    teve_fix = np.maximum.accumulate(status >= 3)
    for ini, fim, idx in _intervalos(t, (status < 3) & teve_fix, duracao_min=0.5):
        voando = em_voo[idx].any()
        _evento(eventos, "gps_sem_fix", "GPS", "critico" if voando else "info", ini, fim,
                "GPS perdeu o fix 3D", f"Sem fix por {fim - ini:.1f} s" + (" durante o voo." if voando else " (no solo)."),
                {"status_min": int(status[idx].min())}, "GPS.Status")
    validos = status >= 3
    if "HDop" in gps.columns:
        hdop = gps["HDop"].to_numpy(dtype=np.float64)
        for ini, fim, idx in _intervalos(t, (hdop > _lim("hdop_max")) & em_voo & validos, duracao_min=1.0):
            _evento(eventos, "gps_hdop_alto", "GPS", "atencao", ini, fim, "Precisão do GPS ruim (HDop alto)",
                    f"HDop até {hdop[idx].max():.1f} em voo.", {"hdop_max": round(float(hdop[idx].max()), 2)}, "GPS.HDop")
    if "NSats" in gps.columns:
        sats = gps["NSats"].to_numpy()
        for ini, fim, idx in _intervalos(t, (sats < _lim("satelites_min")) & em_voo & validos, duracao_min=1.0):
            _evento(eventos, "gps_poucos_satelites", "GPS", "atencao", ini, fim, "Poucos satélites",
                    f"Mínimo de {sats[idx].min()} satélites em voo.", {"satelites_min": int(sats[idx].min())}, "GPS.NSats")
    g = gps[validos]
    if len(g) > 2:
        tg = dv.segundos(g, origem)
        dist = utils.distancia_haversine_metros(g["Lat"].to_numpy()[:-1], g["Lng"].to_numpy()[:-1],
                                                g["Lat"].to_numpy()[1:], g["Lng"].to_numpy()[1:])
        dt = np.maximum(np.diff(tg), 1e-3)
        for i in np.nonzero(dist / dt > _lim("gps_salto_ms"))[0]:
            _evento(eventos, "gps_salto", "GPS", "atencao", tg[i], tg[i + 1], "Salto de posição do GPS",
                    f"A posição pulou {dist[i]:.0f} m em {dt[i]:.2f} s — fisicamente impossível.",
                    {"distancia_m": round(float(dist[i]), 1)}, "GPS.Lat/Lng")


def _controle(eventos, dados, origem, voos, ficha):
    if not controladora_comanda(ficha) or not ficha["controladora"].get("calibrada", True):
        return
    att = dados.get("ATT")
    if att is None or not len(att) or "DesRoll" not in att.columns:
        return
    t = dv.segundos(att, origem)
    em_voo = _em_voo(t, voos)
    for eixo in ("Roll", "Pitch"):
        erro = np.abs(att[f"Des{eixo}"].to_numpy(dtype=np.float64) - att[eixo].to_numpy(dtype=np.float64))
        ruim = (erro > _lim("controle_erro_graus")) & em_voo
        for ini, fim, idx in _intervalos(t, ruim, duracao_min=_lim("controle_duracao_s")):
            _evento(eventos, "controle_nao_segue", "Controle", "atencao", ini, fim,
                    f"O avião não seguiu o {eixo.lower()} pedido",
                    f"Diferença de até {erro[idx].max():.0f}° entre o pedido e o real por {fim - ini:.1f} s.",
                    {"erro_max_graus": round(float(erro[idx].max()), 1)}, f"ATT.Des{eixo}/{eixo}")


def _atitude_e_trajetoria(eventos, dados, origem, voos, atitude, fonte_atitude):
    if atitude is None or not voos:
        return
    confianca = "media" if fonte_atitude == "reprocessada" else "alta"
    t = atitude["t"].to_numpy()
    em_voo = _em_voo(t, voos)
    roll, pitch = atitude["Roll"].to_numpy(), atitude["Pitch"].to_numpy()
    for ini, fim, idx in _intervalos(t, (np.abs(roll) > _lim("roll_extremo_graus")) & em_voo, duracao_min=0.3):
        _evento(eventos, "roll_extremo", "Atitude", "atencao", ini, fim, "Inclinação lateral extrema",
                f"Roll de até {roll[idx][np.argmax(np.abs(roll[idx]))]:+.0f}°.",
                {"roll_max_graus": round(float(roll[idx][np.argmax(np.abs(roll[idx]))]), 0)},
                f"atitude {fonte_atitude}", confianca)
    for ini, fim, idx in _intervalos(t, (np.abs(pitch) > _lim("pitch_extremo_graus")) & em_voo, duracao_min=0.3):
        _evento(eventos, "pitch_extremo", "Atitude", "atencao", ini, fim, "Pitch extremo",
                f"Pitch de até {pitch[idx][np.argmax(np.abs(pitch[idx]))]:+.0f}°.",
                {"pitch_max_graus": round(float(pitch[idx][np.argmax(np.abs(pitch[idx]))]), 0)},
                f"atitude {fonte_atitude}", confianca)

    gps = dv.gps_valido(dados)
    if gps is None or "VZ" not in gps.columns:
        return
    tg = dv.segundos(gps, origem)
    vel = gps["Spd"].to_numpy(dtype=np.float64)
    gama = np.degrees(np.arctan2(-gps["VZ"].to_numpy(dtype=np.float64), np.maximum(vel, 0.1)))
    voando = _em_voo(tg, voos) & (vel > 6)
    for ini, fim, idx in _intervalos(tg, (gama < _lim("descida_ingreme_graus")) & voando,
                                     duracao_min=_lim("descida_ingreme_duracao_s")):
        _evento(eventos, "descida_ingreme", "Trajetória", "atencao", ini, fim, "Descida íngreme",
                f"Trajetória até {gama[idx].min():.0f}° abaixo do horizonte, a até {vel[idx].max():.0f} m/s.",
                {"angulo_trajetoria_min_graus": round(float(gama[idx].min()), 0),
                 "velocidade_max_ms": round(float(vel[idx].max()), 1)}, "GPS.VZ/Spd")
    # Ângulo de ataque aproximado = pitch - ângulo da trajetória (sem Pitot,
    # o vento distorce: confiança baixa).
    p = np.interp(tg, t, pitch)
    alfa = p - gama
    for ini, fim, idx in _intervalos(tg, (alfa > _lim("angulo_ataque_alto_graus")) & voando,
                                     duracao_min=_lim("angulo_ataque_duracao_s"), juntar_s=1.5):
        _evento(eventos, "angulo_ataque_alto", "Aerodinâmica", "atencao", ini, fim,
                "Ângulo de ataque estimado alto (perto do estol)",
                f"Pitch − trajetória ≈ {np.median(alfa[idx]):.0f}° (máx. {alfa[idx].max():.0f}°) por {fim - ini:.0f} s, "
                f"a {np.median(vel[idx]):.0f} m/s de velocidade no solo. Estimativa sem Pitot: o vento muda esse valor.",
                {"alfa_mediano_graus": round(float(np.median(alfa[idx])), 1),
                 "alfa_max_graus": round(float(alfa[idx].max()), 1),
                 "velocidade_mediana_ms": round(float(np.median(vel[idx])), 1)},
                f"atitude {fonte_atitude} + GPS", "baixa")


_PADROES_MENSAGEM = [
    # (regex, código, categoria, gravidade se comanda, gravidade se só registra, título)
    (r"failsafe", "failsafe", "Sistema", "critico", "info", "Failsafe"),
    # "yaw aligned to GPS" é o alinhamento normal do rumo após a decolagem: não entra.
    (r"EKF.*(stopped aiding|lane switch|variance|yaw reset)", "ekf", "Estimador (EKF)", "atencao", "info",
     "Estimador de posição instável"),
    (r"Crash", "crash", "Sistema", "critico", "critico", "Detecção de queda"),
    (r"(Compass|Mag).*not healthy", "bussola", "Configuração", "atencao", "atencao", "Bússola com problema"),
    (r"Roll/Pitch inconsistent", "ahrs_inconsistente", "Configuração", "atencao", "atencao",
     "Atitude inconsistente antes do voo"),
    (r"Bad fix|GPS.*not healthy", "gps_prearm", "GPS", "info", "info", "GPS ainda sem fix bom"),
    (r"Radio failsafe|Waiting for RC|RC not", "rc_ausente", "Rádio", "atencao", "info", "Controladora sem sinal de rádio"),
]


def _mensagens(eventos, dados, origem, ficha, voos):
    msg = dados.get("MSG")
    if msg is None or not len(msg):
        return
    comanda = controladora_comanda(ficha)
    t = dv.segundos(msg, origem)
    textos = msg["Message"].astype(str).to_numpy()
    for padrao, codigo, categoria, g_comanda, g_registra, titulo in _PADROES_MENSAGEM:
        casou = np.array([bool(re.search(padrao, x, re.IGNORECASE)) for x in textos])
        if not casou.any():
            continue
        exemplos = list(dict.fromkeys(textos[casou]))[:4]
        gravidade = g_comanda if comanda else g_registra
        # PreArm = checagem antes de armar (repetida a cada 30 s enquanto
        # a placa não arma); não é algo que "aconteceu durante o voo".
        reais = casou & ~np.char.startswith(textos.astype(str), "PreArm")
        so_prearm = not reais.any()
        if so_prearm:
            gravidade, contadas = "info", casou
        else:
            contadas = reais
        em_voo = _em_voo(t[reais], voos).any()
        observacao = "" if comanda else " A controladora só registra (não comanda o avião), então isto não afetou o voo diretamente."
        if so_prearm:
            observacao += " Só avisos PreArm (checagem antes de armar), nenhum durante o voo."
        _evento(eventos, f"msg_{codigo}", categoria, gravidade, t[contadas][0], t[contadas][-1], titulo,
                f"{contadas.sum()} mensagem(ns){' durante o voo' if em_voo else ''}: " + " | ".join(exemplos) + observacao,
                {"quantidade": int(contadas.sum()), "so_prearm": so_prearm, "exemplos": exemplos}, "MSG")


def _configuracao(eventos, dados, origem, ficha, voos, deteccao):
    """Verificações de instalação/configuração que tornam dados não confiáveis."""
    qualidade = []
    parametros = {}
    parm = dados.get("PARM")
    if parm is not None and len(parm):
        parametros = parm.drop_duplicates("Name", keep="last").set_index("Name")["Value"].to_dict()

    orientacao = deteccao.get("orientacao")
    if orientacao == "invertida_180":
        configurada = int(parametros.get("AHRS_ORIENTATION", 0))
        _evento(eventos, "placa_invertida", "Configuração", "critico", deteccao.get("inicio_corrida_s"),
                deteccao.get("fim_corrida_s"), "Controladora montada ao contrário (girada 180°)",
                f"Na corrida de decolagem o GPS mostra +{deteccao['aceleracao_gps_ms2']:.1f} m/s² para a frente, mas o "
                f"acelerômetro X variou {deteccao['variacao_acc_x_ms2']:+.1f} m/s² (para trás). AHRS_ORIENTATION = "
                f"{configurada}; para placa com a seta para trás deveria ser 4 (Yaw180). Roll/pitch gravados pelo "
                "ArduPilot (ATT) estão errados neste log — a análise usa a atitude recalculada.",
                deteccao, "IMU.AccX + GPS.Spd")
        qualidade.append("Atitude gravada (ATT/AHR2/AOA) não confiável: placa ao contrário. Usada atitude recalculada da IMU.")
    if not ficha["controladora"].get("calibrada", True):
        qualidade.append("Ficha indica acelerômetro/nível não calibrados: erros de alguns graus em roll/pitch.")

    refs = dv.referencias_altitude(dados)
    for voo in voos:
        janela = dv.cortar_janela(dados, voo["inicio_s"], voo["fim_s"], origem)
        div = dv.divergencia_altitude(janela, origem, refs)
        if div and div["p95_m"] > _lim("divergencia_altitude_m"):
            _evento(eventos, "barometro_contaminado", "Sensores", "atencao", voo["inicio_s"], voo["fim_s"],
                    "Barômetro e GPS discordam em voo",
                    f"Diferença de até {div['max_m']:.0f} m (aos {_mmss(div['t'])}). Saltos rápidos no barômetro "
                    "costumam vir do fluxo de ar/hélice: proteja o sensor com espuma.",
                    {"max_m": round(div["max_m"], 1), "p95_m": round(div["p95_m"], 1)}, "BARO.Alt vs GPS.Alt")
            qualidade.append("Altitude pelo barômetro não confiável em voo (contaminada pelo fluxo de ar); preferir GPS.")
    if not controladora_comanda(ficha):
        qualidade.append("Controladora só registra: modos de voo, failsafes e saídas (RCOU) não comandaram o avião.")
        rcin = dados.get("RCIN")
        if rcin is None or rcin.filter(like="C").nunique().max() <= 1:
            qualidade.append("Comandos do piloto não registrados (rádio não ligado à controladora).")
    if "ARSP" not in dados:
        qualidade.append("Sem tubo de Pitot: velocidade só em relação ao solo (GPS); o vento afeta velocidades e ângulos.")
    elif int(parametros.get("ARSPD_TYPE", 1)) == 0 or int(parametros.get("ARSPD_USE", 1)) == 0:
        qualidade.append("Mensagens ARSP gravadas, mas o sensor de velocidade do ar está desativado/não usado "
                         "(ARSPD_TYPE/ARSPD_USE = 0): ignorar ARSP; velocidade só pelo GPS.")
    vibe = dados.get("VIBE")
    if vibe is not None and len(vibe) and {"VibeX", "VibeY", "VibeZ"} <= set(vibe.columns):
        medias = vibe[["VibeX", "VibeY", "VibeZ"]].mean()
        # VIBE é desvio da aceleração (perto de 0 parado). Média perto de 1 g
        # ou 2 g sugere que o campo traz aceleração bruta: não é vibração.
        if any(abs(m - g) < 1.0 for m in medias for g in (9.81, 19.62)) and vibe[["VibeX", "VibeY", "VibeZ"]].std().max() < 2:
            qualidade.append(f"VIBE com média suspeita ({', '.join(f'{m:.1f}' for m in medias)} m/s², quase constante): "
                             "parece aceleração bruta, não vibração. Confirmar pela IMU antes de concluir sobre vibração.")
    dsf = dados.get("DSF")
    if dsf is not None and "Dp" in dsf.columns and dsf["Dp"].max() > 0:
        _evento(eventos, "log_perdeu_mensagens", "Sistema", "atencao", None, None, "Log perdeu mensagens",
                f"{int(dsf['Dp'].max())} mensagens descartadas pelo registrador.", {}, "DSF.Dp")
    return qualidade


# -----------------------------------------------------------------------
# Função principal
# -----------------------------------------------------------------------
def detectar(dados, ficha):
    """
    Roda todos os detectores. Devolve dict com "eventos" (ordenados por
    instante), "voos", "atitude" (fonte usada e orientação), "bateria"
    (resumo) e "qualidade_dados" (o que não é confiável neste log).
    """
    origem = dv.origem_us(dados)
    voos = detectar_voos(dados, origem)
    deteccao = atitude_mod.detectar_orientacao(dados, origem)

    # Atitude: recalculada quando a placa está fora da posição/calibração;
    # senão, a gravada pelo ArduPilot.
    orientacao_ficha = ficha["controladora"].get("orientacao", "normal")
    orientacao = deteccao.get("orientacao") or orientacao_ficha
    usar_reprocessada = orientacao != "normal" or not ficha["controladora"].get("calibrada", True)
    atitude = None
    fonte_atitude = None
    if usar_reprocessada and "IMU" in dados:
        inicio = max(0.0, voos[0]["inicio_s"] - 120) if voos else None
        fim = voos[-1]["fim_s"] + 30 if voos else None
        atitude = atitude_mod.reprocessar_atitude(dados, orientacao, inicio, fim)
        fonte_atitude = "reprocessada"
    elif "ATT" in dados:
        att = dados["ATT"]
        atitude = att.assign(t=dv.segundos(att, origem))[["t", "Roll", "Pitch", "Yaw"]]
        fonte_atitude = "ATT"

    eventos = []
    for voo in voos:
        _evento(eventos, "decolagem", "Fases do voo", "info", voo["inicio_s"], voo["inicio_s"],
                "Início do movimento (corrida/decolagem)",
                f"Velocidade GPS passa de {_lim('velocidade_voo_ms'):.0f} m/s; trecho de {voo['duracao_s']:.0f} s, "
                f"máx. {voo['velocidade_max_ms']:.0f} m/s.", voo, "GPS.Spd")
        _fim_do_voo(eventos, dados, origem, voo, atitude)
    impactos = _janelas_de_impacto(eventos)
    bateria = _bateria(eventos, dados, origem, ficha, voos, impactos)
    _vibracao(eventos, dados, origem, voos, impactos)
    _gps(eventos, dados, origem, voos)
    _controle(eventos, dados, origem, voos, ficha)
    _atitude_e_trajetoria(eventos, dados, origem, voos, atitude, fonte_atitude)
    _mensagens(eventos, dados, origem, ficha, voos)
    qualidade = _configuracao(eventos, dados, origem, ficha, voos, deteccao)

    ordem = {g: i for i, g in enumerate(GRAVIDADES)}
    eventos.sort(key=lambda e: (e["inicio_s"] if e["inicio_s"] is not None else -1, ordem[e["gravidade"]]))
    return {
        "eventos": eventos,
        "voos": voos,
        "atitude": {"fonte": fonte_atitude, "orientacao_usada": orientacao, "deteccao_orientacao": deteccao},
        "atitude_serie": atitude,
        "bateria": bateria,
        "qualidade_dados": list(dict.fromkeys(qualidade)),
    }
