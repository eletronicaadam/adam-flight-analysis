"""
espectro.py

Análise de frequência da vibração: espectro (método de Welch),
espectrograma e leitura do "batch sampler" do ArduPilot (mensagens
ISBH/ISBD), que grava o acelerômetro/giroscópio em alta taxa.

Por que importa: a mensagem IMU normal é gravada a ~25-50 Hz, então só
mostra frequências até ~12-25 Hz (metade da taxa, o limite de Nyquist).
Motor e hélice vibram a dezenas ou centenas de Hz; para enxergá-los é
preciso ligar o batch sampler (INS_LOG_BAT_MASK) antes do voo.
"""

import numpy as np

import utils


def _segundos(df, origem):
    return (df["TimeUS"].to_numpy(dtype=np.int64) - origem) / 1e6


def amostras_imu(dados, origem, inicio, fim, instancia=0):
    """
    Amostras da mensagem IMU no trecho: (t, acelerações Nx3 em m/s²,
    giros Nx3 em rad/s, taxa de amostragem em Hz) ou None.
    """
    imu = dados.get("IMU")
    if imu is None or not len(imu):
        return None
    imu = utils.filtrar_instancia(imu, "I", instancia)
    t = _segundos(imu, origem)
    dentro = (t >= inicio) & (t <= fim)
    if dentro.sum() < 16:
        return None
    t = t[dentro]
    acc = imu[["AccX", "AccY", "AccZ"]].to_numpy(dtype=np.float64)[dentro]
    gyr = imu[["GyrX", "GyrY", "GyrZ"]].to_numpy(dtype=np.float64)[dentro]
    taxa = 1.0 / float(np.median(np.diff(t)))
    return t, acc, gyr, taxa


def espectro_welch(x, taxa, tamanho=256):
    """
    Espectro de amplitude pelo método de Welch (média de FFTs em janelas de
    Hann com 50% de sobreposição). Devolve (frequências em Hz, amplitude
    na unidade do sinal): uma vibração senoidal de 5 m/s² a 80 Hz aparece
    como um pico de ~5 em 80 Hz. Remove a média (gravidade/bias) antes.
    """
    x = np.asarray(x, dtype=np.float64)
    x = x[np.isfinite(x)]
    if len(x) < 16:
        return np.array([]), np.array([])
    tamanho = int(min(tamanho, 2 ** int(np.log2(len(x)))))
    passo = tamanho // 2
    janela = np.hanning(tamanho)
    blocos = [x[i:i + tamanho] for i in range(0, len(x) - tamanho + 1, passo)]
    # amplitude de cada bloco; média quadrática entre blocos
    amplitudes = [2 * np.abs(np.fft.rfft((b - b.mean()) * janela)) / janela.sum() for b in blocos]
    freq = np.fft.rfftfreq(tamanho, d=1.0 / taxa)
    return freq, np.sqrt(np.mean(np.square(amplitudes), axis=0))


def espectrograma(t, x, taxa, janela_s=2.0):
    """
    Espectro ao longo do tempo: (centros de tempo, frequências, matriz em
    dB [frequência x tempo]).
    """
    x = np.asarray(x, dtype=np.float64)
    tamanho = int(2 ** max(4, int(np.log2(max(16, janela_s * taxa)))))
    passo = max(1, tamanho // 2)
    janela = np.hanning(tamanho)
    colunas, centros = [], []
    for i in range(0, len(x) - tamanho + 1, passo):
        b = x[i:i + tamanho]
        if not np.isfinite(b).all():
            continue
        colunas.append(np.abs(np.fft.rfft((b - b.mean()) * janela)))
        centros.append(t[i + tamanho // 2])
    if not colunas:
        return np.array([]), np.array([]), np.zeros((0, 0))
    matriz = 20 * np.log10(np.maximum(np.array(colunas).T, 1e-6))
    return np.array(centros), np.fft.rfftfreq(tamanho, d=1.0 / taxa), matriz


def picos(freq, amplitude, quantidade=3, freq_min=2.0):
    """As `quantidade` maiores frequências de pico (ignora < freq_min Hz)."""
    if len(freq) < 3:
        return []
    validos = freq >= freq_min
    f, a = freq[validos], amplitude[validos]
    maximos = [i for i in range(1, len(a) - 1) if a[i] >= a[i - 1] and a[i] >= a[i + 1]]
    maximos.sort(key=lambda i: a[i], reverse=True)
    return [(float(f[i]), float(a[i])) for i in maximos[:quantidade]]


def lotes_batch_sampler(dados, origem):
    """
    Junta os lotes do batch sampler (ISBH = cabeçalho, ISBD = dados).
    Devolve lista de dicts: sensor ("acelerometro"/"giroscopio"),
    instancia, t0 (s), taxa (Hz) e amostras Nx3 (m/s² ou rad/s).
    """
    isbh, isbd = dados.get("ISBH"), dados.get("ISBD")
    if isbh is None or isbd is None or not len(isbh) or not len(isbd):
        return []
    lotes = []
    por_lote = {n: g.sort_values("seqno") for n, g in isbd.groupby("N")}
    for _, cab in isbh.iterrows():
        grupo = por_lote.get(cab["N"])
        if grupo is None or not len(grupo) or not cab["mul"]:
            continue
        eixos = [np.concatenate([np.asarray(v, dtype=np.float64) for v in grupo[c]]) for c in ("x", "y", "z")]
        n = min(len(e) for e in eixos)
        if "smp_cnt" in isbh.columns and cab["smp_cnt"]:
            n = min(n, int(cab["smp_cnt"]))
        amostras = np.column_stack([e[:n] for e in eixos]) / float(cab["mul"])
        inicio_us = cab["SampleUS"] if "SampleUS" in isbh.columns else cab["TimeUS"]
        lotes.append({
            "sensor": "acelerometro" if int(cab["type"]) == 0 else "giroscopio",
            "instancia": int(cab["instance"]),
            "t0": (float(inicio_us) - origem) / 1e6,
            "taxa": float(cab["smp_rate"]),
            "amostras": amostras,
        })
    return lotes


def espectro_batch(lotes, inicio, fim, sensor="acelerometro", instancia=0):
    """Espectro médio dos lotes do batch sampler dentro do trecho (por eixo)."""
    escolhidos = [l for l in lotes if l["sensor"] == sensor and l["instancia"] == instancia
                  and inicio <= l["t0"] <= fim and len(l["amostras"]) >= 64]
    if not escolhidos:
        return None
    taxa = escolhidos[0]["taxa"]
    escolhidos = [l for l in escolhidos if abs(l["taxa"] - taxa) < 1]
    # Mesmo tamanho de janela em todos os lotes: espectros com resoluções de
    # frequência diferentes não podem ser somados ponto a ponto.
    menor = min(len(l["amostras"]) for l in escolhidos)
    tamanho = min(512, 2 ** int(np.floor(np.log2(menor))))
    resultado = []
    for eixo in range(3):
        espectros = [espectro_welch(l["amostras"][:, eixo], taxa, tamanho=tamanho) for l in escolhidos]
        n = min(len(e[0]) for e in espectros)
        freq = espectros[0][0][:n]
        resultado.append(np.mean([e[1][:n] for e in espectros], axis=0))
    return {"freq": freq, "eixos": resultado, "taxa": taxa, "lotes": len(escolhidos)}
