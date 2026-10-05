"""
dados_voo.py

Prepara os dados de um log para o painel interativo do dashboard:
recorta o trecho de tempo escolhido, reduz o número de pontos (para o
navegador continuar fluido) e monta o dicionário que vai para o
componente JavaScript (gráficos + mapa).

Todo tempo aqui é medido em segundos desde a primeira mensagem do log
(a mesma base para todos os sensores), para que gráficos, mapa e o
seletor de trecho fiquem sincronizados.
"""

import math
from xml.sax.saxutils import escape

import numpy as np
import pandas as pd

import utils

# Mensagens usadas pelo painel. Recortar só elas economiza processamento
# (IMU, por exemplo, tem centenas de linhas por segundo e não é usada).
TIPOS_DO_PAINEL = ("GPS", "BAT", "BARO", "ARSP", "VIBE", "MODE")

# Fix 3D ou melhor (3D, DGPS, RTK float, RTK fixo).
GPS_FIX_MINIMO = 3

# Intervalo (s) entre duas amostras seguidas acima do qual consideramos
# que houve uma falha no log (ex: GPS perdeu o fix). Medido nas amostras
# originais, antes da redução de pontos.
LACUNA_MAXIMA_S = 3.0

# Salto de tempo (µs) entre amostras vizinhas que só pode ser registro
# corrompido (nenhum sensor fica 10 min sem gravar no meio do voo).
SALTO_IMPOSSIVEL_US = 600 * 1_000_000

# Período (s) antes da decolagem usado como referência de "solo" para a
# altitude, e diferença (m) entre barômetro e GPS em voo a partir da qual
# o painel avisa que uma das duas fontes não é confiável.
SOLO_ANTES_DA_DECOLAGEM_S = 60.0
DIVERGENCIA_ALTITUDE_M = 5.0

# Velocidade (m/s) acima da qual consideramos que a aeronave está voando,
# para detectar automaticamente o trecho em voo.
VELOCIDADE_EM_VOO_MS = 3.0

MODOS_PLANE = {
    0: "MANUAL", 1: "CIRCLE", 2: "STABILIZE", 3: "TRAINING", 4: "ACRO",
    5: "FBWA", 6: "FBWB", 7: "CRUISE", 8: "AUTOTUNE", 10: "AUTO", 11: "RTL",
    12: "LOITER", 13: "TAKEOFF", 14: "AVOID_ADSB", 15: "GUIDED",
    17: "QSTABILIZE", 18: "QHOVER", 19: "QLOITER", 20: "QLAND", 21: "QRTL",
    22: "QAUTOTUNE", 23: "QACRO", 24: "THERMAL", 25: "LOITER_ALT_QLAND",
    26: "AUTOLAND",
}
MODOS_COPTER = {
    0: "STABILIZE", 1: "ACRO", 2: "ALT_HOLD", 3: "AUTO", 4: "GUIDED",
    5: "LOITER", 6: "RTL", 7: "CIRCLE", 9: "LAND", 11: "DRIFT", 13: "SPORT",
    14: "FLIP", 15: "AUTOTUNE", 16: "POSHOLD", 17: "BRAKE", 18: "THROW",
    19: "AVOID_ADSB", 20: "GUIDED_NOGPS", 21: "SMART_RTL", 22: "FLOWHOLD",
    23: "FOLLOW", 24: "ZIGZAG", 25: "SYSTEMID", 26: "AUTOROTATE",
    27: "AUTO_RTL", 28: "TURTLE",
}
MODOS_ROVER = {
    0: "MANUAL", 1: "ACRO", 3: "STEERING", 4: "HOLD", 5: "LOITER",
    6: "FOLLOW", 7: "SIMPLE", 8: "DOCK", 9: "CIRCLE", 10: "AUTO", 11: "RTL",
    12: "SMART_RTL", 15: "GUIDED",
}


# -----------------------------------------------------------------------
# Base de tempo e recorte
# -----------------------------------------------------------------------
def _tempos_confiaveis(df):
    """
    TimeUS de um tipo de mensagem sem registros corrompidos isolados:
    um ponto que salta mais de SALTO_IMPOSSIVEL_US em relação aos dois
    vizinhos é lixo (ex: bloco do cartão SD meio gravado) e não pode
    definir o início ou o fim do log.
    """
    t = df["TimeUS"].to_numpy(dtype=np.float64)
    if len(t) < 3:
        return t
    salto = np.abs(np.diff(t)) > SALTO_IMPOSSIVEL_US
    isolado = np.zeros(len(t), dtype=bool)
    isolado[1:-1] = salto[:-1] & salto[1:]
    isolado[0] = salto[0]
    isolado[-1] = salto[-1]
    return t[~isolado]


def _limites_us(dados):
    tempos = [
        _tempos_confiaveis(df)
        for df in dados.values()
        if "TimeUS" in df.columns and len(df)
    ]
    tempos = [t for t in tempos if len(t)]
    if not tempos:
        raise ValueError(
            "O log não tem mensagens com TimeUS (logs muito antigos, de "
            "firmware anterior ao 3.3, usam TimeMS e não são suportados)."
        )
    return int(min(t.min() for t in tempos)), int(max(t.max() for t in tempos))


def origem_us(dados):
    """TimeUS da primeira mensagem do log (início da base de tempo comum)."""
    return _limites_us(dados)[0]


def duracao_s(dados, origem):
    """Duração total do log, em segundos."""
    return (_limites_us(dados)[1] - origem) / 1e6


def segundos(df, origem):
    """Tempo de cada linha em segundos na base comum do log."""
    return (df["TimeUS"].to_numpy(dtype=np.int64) - origem) / 1e6


def cortar_janela(dados, inicio_s, fim_s, origem, tipos=TIPOS_DO_PAINEL):
    """
    Devolve um novo dicionário só com as linhas dentro do trecho
    [inicio_s, fim_s] (segundos na base comum) dos tipos indicados.
    """
    janela = {}
    for tipo in tipos:
        df = dados.get(tipo)
        if df is None or "TimeUS" not in df.columns:
            continue
        t = segundos(df, origem)
        recorte = df[(t >= inicio_s) & (t <= fim_s)].reset_index(drop=True)
        if len(recorte):
            janela[tipo] = recorte
    return janela


def gps_valido(dados):
    """GPS principal (instância 0) só com fix 3D ou melhor e posição válida."""
    gps = dados.get("GPS")
    if gps is None or not len(gps):
        return None
    gps = utils.filtrar_instancia(gps, "I")
    gps = gps[(gps["Status"] >= GPS_FIX_MINIMO) & (gps["Lat"] != 0) & (gps["Lng"] != 0)]
    return gps.reset_index(drop=True) if len(gps) else None


def detectar_trecho_em_voo(dados, origem, margem_s=10.0):
    """
    Estima o trecho em que a aeronave estava se movendo (velocidade GPS
    ou do ar acima de VELOCIDADE_EM_VOO_MS), com uma margem antes e
    depois. Devolve (inicio_s, fim_s) ou None se não der para estimar.
    """
    tempos = []
    gps = gps_valido(dados)
    if gps is not None:
        tempos.append(segundos(gps, origem)[gps["Spd"].to_numpy() > VELOCIDADE_EM_VOO_MS])
    arsp = dados.get("ARSP")
    if arsp is not None and "Airspeed" in arsp.columns:
        arsp = utils.filtrar_instancia(arsp, "I")
        tempos.append(segundos(arsp, origem)[arsp["Airspeed"].to_numpy() > VELOCIDADE_EM_VOO_MS])

    tempos = np.concatenate(tempos) if tempos else np.array([])
    if len(tempos) < 2:
        return None
    total = duracao_s(dados, origem)
    return max(0.0, float(tempos.min()) - margem_s), min(total, float(tempos.max()) + margem_s)


# -----------------------------------------------------------------------
# Redução de pontos
# -----------------------------------------------------------------------
def indices_reduzidos(valores, max_pontos):
    """
    Escolhe no máximo ~max_pontos índices de uma série preservando os
    picos: divide em blocos e mantém o mínimo e o máximo de cada bloco.
    Assim um pico de corrente de 1 amostra continua aparecendo no
    gráfico mesmo com o log reduzido.
    """
    n = len(valores)
    if n <= max_pontos:
        return np.arange(n)
    blocos = max(1, max_pontos // 2)
    limites = np.linspace(0, n, blocos + 1).astype(np.int64)
    # Troca NaN por +-inf só para escolher min/max sem erro.
    v = np.asarray(valores, dtype=np.float64)
    v_min = np.where(np.isnan(v), np.inf, v)
    v_max = np.where(np.isnan(v), -np.inf, v)
    escolhidos = []
    for a, b in zip(limites[:-1], limites[1:]):
        if b <= a:
            continue
        escolhidos.append(a + int(np.argmin(v_min[a:b])))
        escolhidos.append(a + int(np.argmax(v_max[a:b])))
    escolhidos.append(n - 1)
    return np.unique(np.array(escolhidos, dtype=np.int64))


def _lista(valores, casas):
    """Array -> lista JSON (NaN/inf viram None, que o JSON aceita)."""
    v = np.round(np.asarray(valores, dtype=np.float64), casas)
    return [x if math.isfinite(x) else None for x in v.tolist()]


def _amostrar(t, idx, colunas):
    """
    Pega as amostras `idx` de cada coluna e insere um ponto vazio (NaN)
    no meio de cada falha real do log (intervalo > LACUNA_MAXIMA_S entre
    amostras originais). Assim o navegador sabe exatamente onde não há
    dado -- e pode interpolar livremente entre os pontos reduzidos.
    """
    t = np.asarray(t, dtype=np.float64)
    # Falha = intervalo bem maior que o normal DESTA mensagem: algumas são
    # gravadas devagar de propósito (ex: PM a cada ~5 s) e não têm falha.
    intervalos = np.diff(t)
    tipico = float(np.median(intervalos)) if len(intervalos) else 0.0
    lacunas = np.nonzero(intervalos > max(LACUNA_MAXIMA_S, 3 * tipico))[0]
    if len(lacunas):
        idx = np.unique(np.concatenate([idx, lacunas, lacunas + 1]))
    t_sel = t[idx]
    sel = {nome: np.asarray(v, dtype=np.float64)[idx] for nome, v in colunas.items()}
    posicoes = np.nonzero(np.isin(idx[:-1], lacunas) & (idx[1:] == idx[:-1] + 1))[0] + 1
    if len(posicoes):
        meio = (t_sel[posicoes - 1] + t_sel[posicoes]) / 2
        t_sel = np.insert(t_sel, posicoes, meio)
        sel = {nome: np.insert(v, posicoes, np.nan) for nome, v in sel.items()}
    return t_sel, sel


def _serie(t, y, nome, unidade, max_pontos, casas=3):
    """Série reduzida para o gráfico, ou None se não houver nenhum valor."""
    y = np.asarray(y, dtype=np.float64)
    if not len(y) or not np.isfinite(y).any():
        return None
    t_sel, sel = _amostrar(t, indices_reduzidos(y, max_pontos), {"y": y})
    return {
        "nome": nome,
        "unidade": unidade,
        "t": _lista(t_sel, 3),
        "y": _lista(sel["y"], casas),
    }


def _adicionar(series, chave, serie):
    if serie is not None:
        series[chave] = serie


# -----------------------------------------------------------------------
# Modos de voo
# -----------------------------------------------------------------------
def tipo_de_veiculo(dados):
    """Detecta o firmware pelas mensagens de texto do log (MSG)."""
    msg = dados.get("MSG")
    if msg is None or "Message" not in msg.columns:
        return None
    texto = " ".join(msg["Message"].astype(str).head(50))
    for nome in ("ArduPlane", "ArduCopter", "ArduRover", "ArduSub", "Blimp", "AntennaTracker"):
        if nome in texto:
            return nome
    return None


def nome_do_modo(valor, veiculo):
    if isinstance(valor, str):
        return valor
    tabela = {"ArduPlane": MODOS_PLANE, "ArduCopter": MODOS_COPTER,
              "ArduRover": MODOS_ROVER}.get(veiculo, {})
    numero = int(valor)
    return tabela.get(numero, f"Modo {numero}")


def modos_na_janela(dados, origem, inicio_s, fim_s, veiculo):
    """
    Lista de mudanças de modo dentro do trecho, incluindo o modo que já
    estava ativo no início do trecho.
    """
    modo = dados.get("MODE")
    if modo is None or not len(modo):
        return []
    coluna = "ModeNum" if "ModeNum" in modo.columns else "Mode"
    t = segundos(modo, origem)
    valores = modo[coluna].tolist()

    resultado = []
    anteriores = np.nonzero(t <= inicio_s)[0]
    if len(anteriores):
        resultado.append({"t": inicio_s, "nome": nome_do_modo(valores[anteriores[-1]], veiculo)})
    for ti, valor in zip(t, valores):
        if inicio_s < ti <= fim_s:
            resultado.append({"t": round(float(ti), 3), "nome": nome_do_modo(valor, veiculo)})
    return resultado


# -----------------------------------------------------------------------
# Montagem do pacote para o painel
# -----------------------------------------------------------------------
def montar_painel(dados, inicio_s, fim_s, max_pontos=4000, max_pontos_mapa=3000):
    """
    Monta o dicionário com tudo que o painel interativo precisa para o
    trecho [inicio_s, fim_s]: séries dos gráficos, trajeto do mapa e
    modos de voo. Os dados são reduzidos para no máximo ~max_pontos por
    série -- o suficiente para a tela, e leve para o navegador.
    """
    origem = origem_us(dados)
    janela = cortar_janela(dados, inicio_s, fim_s, origem)
    veiculo = tipo_de_veiculo(dados)
    series = {}

    # --- Velocidades ---
    gps_todo = gps_valido(dados)
    gps = gps_valido(janela)
    if gps is not None:
        _adicionar(series, "vel_solo", _serie(segundos(gps, origem), gps["Spd"],
                                              "Velocidade solo (GPS)", "m/s", max_pontos))
    arsp = janela.get("ARSP")
    if arsp is not None and "Airspeed" in arsp.columns:
        arsp = utils.filtrar_instancia(arsp, "I")
        _adicionar(series, "vel_ar", _serie(segundos(arsp, origem), arsp["Airspeed"],
                                            "Velocidade do ar", "m/s", max_pontos))

    # --- Altitude em relação ao solo, pelas duas fontes ---
    # Barômetro e GPS erram de jeitos diferentes (o barômetro sente o
    # fluxo de ar/hélice; o GPS tem erro vertical de alguns metros), então
    # mostramos os dois e avisamos quando discordam. A referência de solo
    # é a mesma para qualquer trecho escolhido.
    refs = referencias_altitude(dados)
    baro = janela.get("BARO")
    baro = utils.filtrar_instancia(baro, "I") if baro is not None else None
    if baro is not None and len(baro) and refs["BARO"] is not None:
        _adicionar(series, "altitude", _serie(segundos(baro, origem), baro["Alt"] - refs["BARO"],
                                              "Altitude (barômetro)", "m", max_pontos, casas=2))
    if gps is not None and refs["GPS"] is not None:
        _adicionar(series, "altitude_gps", _serie(segundos(gps, origem), gps["Alt"] - refs["GPS"],
                                                  "Altitude (GPS)", "m", max_pontos, casas=2))
    avisos = []
    divergencia = divergencia_altitude(janela, origem, refs)
    if divergencia and divergencia["p95_m"] > DIVERGENCIA_ALTITUDE_M:
        m, s = divmod(divergencia["t"], 60)
        avisos.append(
            f"Barômetro e GPS discordam durante o voo: até {divergencia['max_m']:.0f} m "
            f"(aos {int(m)}:{s:04.1f}). Barômetro sem proteção costuma ser afetado pelo "
            "fluxo de ar e pela hélice (saltos rápidos, que acompanham o pitch); o GPS tem "
            "erro vertical de alguns metros, mas varia de forma suave. Compare as duas linhas "
            "no gráfico de altitude."
        )

    # --- Bateria ---
    bat = janela.get("BAT")
    bat = utils.filtrar_instancia(bat, "Inst") if bat is not None else None
    if bat is not None and len(bat):
        t_bat = segundos(bat, origem)
        tensao = bat["Volt"].to_numpy(dtype=np.float64)
        _adicionar(series, "tensao", _serie(t_bat, tensao, "Tensão", "V", max_pontos))
        # Monitores só de tensão gravam a corrente como NaN: nesse caso
        # não há corrente, potência nem consumo para mostrar.
        if "Curr" in bat.columns and np.isfinite(bat["Curr"].to_numpy(dtype=np.float64)).any():
            corrente = bat["Curr"].to_numpy(dtype=np.float64)
            potencia = tensao * corrente
            # Consumo acumulado desde o início do trecho (integral
            # trapezoidal); amostras sem corrente (NaN) não somam nada.
            termos = np.nan_to_num((corrente[1:] + corrente[:-1]) / 2 * np.diff(t_bat))
            consumo_as = np.concatenate([[0.0], np.cumsum(termos)])
            _adicionar(series, "corrente", _serie(t_bat, corrente, "Corrente", "A", max_pontos))
            _adicionar(series, "potencia", _serie(t_bat, potencia, "Potência", "W", max_pontos, casas=1))
            _adicionar(series, "consumo", _serie(t_bat, consumo_as / 3.6, "Consumo no trecho", "mAh",
                                                 max_pontos, casas=1))

    trajeto = _trajeto(gps, gps_todo, origem, refs, max_pontos_mapa)

    return {
        "inicio": round(float(inicio_s), 3),
        "fim": round(float(fim_s), 3),
        "veiculo": veiculo,
        "series": series,
        "trajeto": trajeto,
        "modos": modos_na_janela(dados, origem, inicio_s, fim_s, veiculo),
        "avisos": avisos,
    }


def _trajeto(gps, gps_todo, origem, refs, max_pontos_mapa):
    """Trajeto reduzido para o mapa (ou None sem GPS com fix no trecho)."""
    if gps is None:
        return None
    # Pontos a intervalos regulares, sempre incluindo o último; falhas
    # reais do GPS viram pontos vazios (o trajeto é interrompido ali).
    passo = max(1, math.ceil(len(gps) / max_pontos_mapa))
    idx = np.unique(np.r_[np.arange(0, len(gps), passo), len(gps) - 1])
    referencia_gps = refs["GPS"] if refs["GPS"] is not None else float(gps_todo["Alt"].iloc[0])
    colunas = {
        "lat": gps["Lat"], "lng": gps["Lng"], "alt": gps["Alt"] - referencia_gps, "vel": gps["Spd"],
    }
    if "GCrs" in gps.columns:
        colunas["rumo"] = gps["GCrs"]
    t_sel, sel = _amostrar(segundos(gps, origem), idx, colunas)
    return {
        "t": _lista(t_sel, 3),
        "lat": _lista(sel["lat"], 7),
        "lng": _lista(sel["lng"], 7),
        "alt": _lista(sel["alt"], 1),
        "vel": _lista(sel["vel"], 2),
        "rumo": _lista(sel["rumo"], 1) if "rumo" in sel else None,
    }


# -----------------------------------------------------------------------
# Painel personalizado (abas)
# -----------------------------------------------------------------------
# Colunas que identificam a instância do sensor em cada tipo de mensagem.
COLUNAS_INSTANCIA = ("I", "Inst", "Instance", "IMU", "C")
_MAX_INSTANCIAS = 16


def coluna_de_instancia(df, campo=None):
    """
    Coluna de instância do sensor, ou None. Só vale coluna inteira com
    valores pequenos: em PIDR/PIDP/TEC2, "I" é o termo integral (float),
    não a instância.
    """
    for coluna in COLUNAS_INSTANCIA:
        if coluna not in df.columns or coluna == campo:
            continue
        valores = df[coluna]
        if not pd.api.types.is_integer_dtype(valores):
            continue
        if len(valores) and (valores.min() < 0 or valores.max() >= _MAX_INSTANCIAS):
            continue
        return coluna
    return None


# Códigos de formato que o DFReader já escala (o multiplicador do FMTU
# deles já foi aplicado na leitura; aplicar de novo daria valor errado).
_FORMATOS_JA_ESCALADOS = set("cCeEL")
_UNIDADES_LEGIVEIS = {
    "m/s/s": "m/s²", "deg": "°", "deglatitude": "°", "deglongitude": "°", "degheading": "°",
    "degC": "°C", "W.h": "Wh", "satellites": "", "rad/s/s": "rad/s²", "instance": "", "-": "",
    "#": "", "UNKNOWN": "", "gauss": "G", "Pa": "Pa", "%": "%",
}


def unidades(dados):
    """
    Unidade e fator de escala de cada campo, lidos das mensagens
    FMTU/UNIT/MULT do próprio log: {"BAT": {"Volt": ("V", 1.0), ...}}.
    O fator converte o valor lido para a unidade (ex: PM.Load vem em
    décimos de %, fator 0,1). Logs sem FMTU devolvem {}.
    """
    fmtu, unit, mult, fmt = dados.get("FMTU"), dados.get("UNIT"), dados.get("MULT"), dados.get("FMT")
    if fmtu is None or unit is None or fmt is None:
        return {}
    rotulos = dict(zip(unit["Id"].astype(int), unit["Label"].astype(str)))
    fatores = dict(zip(mult["Id"].astype(int), mult["Mult"].astype(float))) if mult is not None else {}
    por_tipo = fmt.drop_duplicates("Type", keep="last").set_index("Type")
    resultado = {}
    for _, linha in fmtu.drop_duplicates("FmtType", keep="last").iterrows():
        tipo = int(linha["FmtType"])
        if tipo not in por_tipo.index:
            continue
        nome = str(por_tipo.loc[tipo, "Name"])
        campos = str(por_tipo.loc[tipo, "Columns"]).split(",")
        formato = str(por_tipo.loc[tipo, "Format"])
        ids_unidade, ids_mult = str(linha["UnitIds"]), str(linha["MultIds"])
        campos_tipo = {}
        for i, campo in enumerate(campos):
            rotulo = rotulos.get(ord(ids_unidade[i]), "") if i < len(ids_unidade) else ""
            fator = fatores.get(ord(ids_mult[i]), 1.0) if i < len(ids_mult) else 1.0
            if (i < len(formato) and formato[i] in _FORMATOS_JA_ESCALADOS) or fator in (0.0, 1.0) \
                    or campo == "TimeUS":
                fator = 1.0
            # O log guarda o fator em float32 (0.1 vira 0.100000001): arredonda.
            campos_tipo[campo] = (_UNIDADES_LEGIVEIS.get(rotulo, rotulo), float(f"{fator:.6g}"))
        resultado[nome] = campos_tipo
    return resultado


def serie_do_log(dados, origem, tipo, campo, inicio_s, fim_s, instancia=0, fator=1.0):
    """(t, y) de um campo do log no trecho, só da instância pedida (y × fator)."""
    df = dados.get(tipo)
    if df is None or campo not in df.columns or "TimeUS" not in df.columns:
        return None
    # Máscara em numpy e só as duas colunas: não copia a mensagem inteira.
    t = segundos(df, origem)
    dentro = (t >= inicio_s) & (t <= fim_s)
    coluna = coluna_de_instancia(df, campo)
    if coluna is not None and instancia is not None:
        dentro &= df[coluna].to_numpy() == instancia
    try:
        y = df[campo].to_numpy(dtype=np.float64)[dentro]
    except (TypeError, ValueError):  # campo de texto
        return None
    return t[dentro], (y * fator if fator != 1.0 else y)


def montar_painel_personalizado(dados, inicio_s, fim_s, linhas, mostrar_mapa=False,
                                max_pontos=4000, max_pontos_mapa=3000):
    """
    Pacote para o painel interativo com gráficos escolhidos pela aba.

    `linhas` é uma lista de {"titulo": str, "series": [serie, ...]}, onde
    cada série é um dict com "nome", "unidade", "casas" (opcional), "cor"
    (opcional), "tracejado"/"cartao" (opcionais, para linhas de limite) e
    os dados de UM destes jeitos:
      - {"tipo": "BAT", "campo": "Volt", "instancia": 0}  (lido do log)
      - {"t": array, "y": array}                         (já calculado)
    """
    origem = origem_us(dados)
    series, linhas_saida, cartoes, cores = {}, [], [{"chave": "tempo", "nome": "Tempo"}], {}
    tracejadas = []
    contador = 0
    for linha in linhas:
        chaves = []
        for spec in linha["series"]:
            if "t" in spec:
                t, y = np.asarray(spec["t"], dtype=np.float64), np.asarray(spec["y"], dtype=np.float64)
                dentro = (t >= inicio_s) & (t <= fim_s)
                par = (t[dentro], y[dentro])
            else:
                par = serie_do_log(dados, origem, spec["tipo"], spec["campo"], inicio_s, fim_s,
                                   spec.get("instancia", 0), spec.get("fator", 1.0))
            if par is None:
                continue
            casas = spec.get("casas", 3)
            serie = _serie(par[0], par[1], spec["nome"], spec.get("unidade", ""), max_pontos, casas)
            if serie is None:
                continue
            chave = f"s{contador}"
            contador += 1
            series[chave] = serie
            chaves.append(chave)
            # Linhas de referência (limites) não viram cartão de valor.
            if spec.get("cartao", True):
                cartoes.append({"chave": chave, "nome": spec["nome"], "unidade": spec.get("unidade", ""),
                                "casas": casas if casas <= 3 else 2})
            if spec.get("tracejado"):
                tracejadas.append(chave)
            if spec.get("cor"):
                cores[chave] = spec["cor"]
        if chaves:
            linhas_saida.append({"titulo": linha["titulo"], "series": chaves})

    trajeto = None
    if mostrar_mapa:
        janela = cortar_janela(dados, inicio_s, fim_s, origem, tipos=("GPS",))
        trajeto = _trajeto(gps_valido(janela), gps_valido(dados), origem,
                           referencias_altitude(dados), max_pontos_mapa)
    veiculo = tipo_de_veiculo(dados)
    return {
        "inicio": round(float(inicio_s), 3),
        "fim": round(float(fim_s), 3),
        "veiculo": veiculo,
        "series": series,
        "linhas": linhas_saida,
        "cartoes": cartoes,
        "cores": cores,
        "tracejadas": tracejadas,
        "mostrar_mapa": bool(mostrar_mapa),
        "trajeto": trajeto,
        "modos": modos_na_janela(dados, origem, inicio_s, fim_s, veiculo) if "MODE" in dados else [],
        "avisos": [],
    }


def instante_decolagem(dados, origem):
    """Primeiro instante (s) com velocidade GPS de voo, ou None."""
    gps = gps_valido(dados)
    if gps is None:
        return None
    rapido = gps["Spd"].to_numpy() > VELOCIDADE_EM_VOO_MS
    return float(segundos(gps, origem)[rapido][0]) if rapido.any() else None


def referencias_altitude(dados):
    """
    Altitude do solo de cada fonte: mediana das leituras paradas no solo
    no minuto antes da decolagem (ou no log todo, se não houve decolagem).
    A primeira leitura não serve: logo após o primeiro fix o GPS costuma
    errar vários metros, e o barômetro deriva com a temperatura.
    Devolve {"BARO": m ou None, "GPS": m ou None}.
    """
    origem = origem_us(dados)
    decolagem = instante_decolagem(dados, origem)

    def no_solo(df):
        t = segundos(df, origem)
        if decolagem is None:
            return df
        perto = (t >= decolagem - SOLO_ANTES_DA_DECOLAGEM_S) & (t <= decolagem - 2.0)
        if perto.any():
            return df[perto]
        antes = t < decolagem
        if antes.any():
            return df[antes]
        # Log que já começa em movimento: o melhor palpite de "solo" são as
        # primeiras leituras (a mediana do log todo incluiria o voo).
        return df[t <= t.min() + 5.0]

    refs = {"BARO": None, "GPS": None}
    baro = dados.get("BARO")
    if baro is not None and len(baro):
        baro = utils.filtrar_instancia(baro, "I")
        if len(baro):
            refs["BARO"] = float(no_solo(baro)["Alt"].median())
    gps = gps_valido(dados)
    if gps is not None:
        # No solo: parado e, se houver HDop, com boa precisão.
        parado = gps[gps["Spd"] < 1.0]
        gps = parado if len(parado) else gps
        if "HDop" in gps.columns:
            preciso = gps[gps["HDop"] <= 2.0]
            gps = preciso if len(preciso) else gps
        refs["GPS"] = float(no_solo(gps)["Alt"].median())
    return refs


def divergencia_altitude(janela, origem, refs):
    """
    Compara barômetro e GPS (em relação ao solo) com a aeronave em
    movimento. Devolve {"max_m", "p95_m", "t"} ou None se não der para
    comparar.
    """
    gps = gps_valido(janela)
    baro = janela.get("BARO")
    if gps is None or baro is None or refs["BARO"] is None or refs["GPS"] is None:
        return None
    baro = utils.filtrar_instancia(baro, "I")
    gps = gps[gps["Spd"] > VELOCIDADE_EM_VOO_MS]
    if len(gps) < 5 or len(baro) < 2:
        return None
    t_gps = segundos(gps, origem)
    alt_baro = np.interp(t_gps, segundos(baro, origem), baro["Alt"].to_numpy() - refs["BARO"])
    diferenca = np.abs(alt_baro - (gps["Alt"].to_numpy() - refs["GPS"]))
    i = int(np.argmax(diferenca))
    return {"max_m": float(diferenca[i]), "p95_m": float(np.percentile(diferenca, 95)), "t": float(t_gps[i])}


def altitude_maxima(dados, janela):
    """
    Altitude máxima do trecho em relação ao solo, por fonte:
    {"BARO": m ou None, "GPS": m ou None}.
    """
    refs = referencias_altitude(dados)
    resultado = {"BARO": None, "GPS": None}
    if refs["BARO"] is not None and "BARO" in janela:
        alt = utils.filtrar_instancia(janela["BARO"], "I")["Alt"]
        if len(alt):
            resultado["BARO"] = float(alt.max()) - refs["BARO"]
    gps = gps_valido(janela)
    if refs["GPS"] is not None and gps is not None:
        resultado["GPS"] = float(gps["Alt"].max()) - refs["GPS"]
    return resultado


def gerar_kml(dados, inicio_s, fim_s, nome):
    """
    Gera um arquivo KML com o trajeto GPS do trecho, para abrir no
    Google Earth ou importar no Google My Maps. Devolve None se não
    houver GPS com fix no trecho.
    """
    origem = origem_us(dados)
    gps = gps_valido(cortar_janela(dados, inicio_s, fim_s, origem, tipos=("GPS",)))
    if gps is None:
        return None
    coordenadas = " ".join(
        f"{lng:.7f},{lat:.7f},{alt:.1f}"
        for lat, lng, alt in zip(gps["Lat"], gps["Lng"], gps["Alt"])
    )
    nome = escape(nome)
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>{nome}</name>
  <Style id="trajeto"><LineStyle><color>ff00a5ff</color><width>3</width></LineStyle></Style>
  <Placemark>
    <name>{nome}</name>
    <styleUrl>#trajeto</styleUrl>
    <LineString>
      <altitudeMode>absolute</altitudeMode>
      <coordinates>{coordenadas}</coordinates>
    </LineString>
  </Placemark>
</Document>
</kml>
"""
