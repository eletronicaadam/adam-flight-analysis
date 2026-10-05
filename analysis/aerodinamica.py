"""
aerodinamica.py

Estimativas aerodinâmicas a partir do log + ficha da aeronave, pensadas
para aviões SEM tubo de Pitot (só GPS):

- densidade do ar (pressão do barômetro + temperatura do ar);
- vento: em curvas, a velocidade no solo varia com o rumo (a favor/contra
  o vento). Supondo velocidade do ar ~constante, procura-se o vento que
  deixa |velocidade no solo − vento| o mais constante possível;
- velocidade do ar estimada = |velocidade no solo − vento|;
- fator de carga n (pela curva e pela aceleração vertical do GPS);
- coeficiente de sustentação em voo: CL = 2·n·m·g / (ρ·V²·S);
- número de Reynolds da corda média;
- ângulo de ataque estimado = pitch − ângulo da trajetória (no ar);
- velocidade de estol para vários CLmax.

Tudo são ESTIMATIVAS: sem Pitot, a precisão depende do vento ser
constante e de haver curvas suficientes para estimá-lo.
"""

import numpy as np

import utils

G = 9.80665
R_AR = 287.05            # J/(kg·K)
VISCOSIDADE_AR = 1.81e-5  # Pa·s (~20 °C)


def densidade_ar(pressao_pa, temperatura_c):
    return float(pressao_pa) / (R_AR * (float(temperatura_c) + 273.15))


def _media_movel(x, n):
    if n <= 1 or len(x) < n:
        return x
    return np.convolve(x, np.ones(n) / n, mode="same")


def estimar_vento(vel_solo, rumo_graus, limite=12.0):
    """
    Vento (m/s) que torna a velocidade do ar mais constante. Devolve dict
    com componentes norte/leste, velocidade, direção DE ONDE vem (graus,
    como na meteorologia), velocidade do ar média, resíduo e cobertura de
    rumos (graus de curva vistos). Só é "confiavel" com quase uma volta
    completa (>= 270°) e velocidade do ar resultante quase constante
    (resíduo < 1,5 m/s): com meia curva, ou com o avião subindo devagar e
    depois mergulhando, a hipótese de velocidade do ar constante falha e o
    vento sai superestimado.
    """
    v = np.asarray(vel_solo, dtype=np.float64)
    r = np.radians(np.asarray(rumo_graus, dtype=np.float64))
    ok = np.isfinite(v) & np.isfinite(r)
    v, r = v[ok], r[ok]
    if len(v) < 10:
        return None
    vn, ve = v * np.cos(r), v * np.sin(r)

    def custo(wn, we):
        va = np.hypot(vn - wn, ve - we)
        return np.std(va)

    melhor = (np.inf, 0.0, 0.0)
    for passo, centro, raio in ((0.5, (0.0, 0.0), limite), (0.05, None, 0.6)):
        cn, ce = (centro if centro else (melhor[1], melhor[2]))
        for wn in np.arange(cn - raio, cn + raio + 1e-9, passo):
            for we in np.arange(ce - raio, ce + raio + 1e-9, passo):
                c = custo(wn, we)
                if c < melhor[0]:
                    melhor = (c, wn, we)
    residuo, wn, we = melhor
    setores = np.unique((np.degrees(r) % 360 // 30).astype(int))
    velocidade = float(np.hypot(wn, we))
    return {
        "norte_ms": float(wn), "leste_ms": float(we),
        "velocidade_ms": velocidade,
        # o vento "vem de" a direção oposta para onde ele sopra
        "direcao_de_graus": float((np.degrees(np.arctan2(we, wn)) + 180) % 360),
        "velocidade_ar_media_ms": float(np.mean(np.hypot(vn - wn, ve - we))),
        "residuo_ms": float(residuo),
        "cobertura_rumos_graus": int(len(setores) * 30),
        "confiavel": len(setores) * 30 >= 270 and residuo < 1.5,
    }


def analisar(gps, origem, massa_kg, area_m2, envergadura_m, rho, vento=None, atitude=None, bat=None,
             velocidade_min_ms=5.0):
    """
    Séries aerodinâmicas nos instantes do GPS (só com o avião em movimento).
    `gps`: DataFrame GPS (instância 0, com fix). `atitude`: DataFrame com
    t/Pitch (opcional). `bat`: DataFrame BAT (opcional, para potência).
    """
    t = (gps["TimeUS"].to_numpy(dtype=np.int64) - origem) / 1e6
    vel = gps["Spd"].to_numpy(dtype=np.float64)
    rumo = np.radians(gps["GCrs"].to_numpy(dtype=np.float64))
    subida = -gps["VZ"].to_numpy(dtype=np.float64) if "VZ" in gps.columns else np.zeros(len(t))
    vn, ve = vel * np.cos(rumo), vel * np.sin(rumo)
    if vento:
        va = np.hypot(vn - vento["norte_ms"], ve - vento["leste_ms"])
    else:
        va = vel.copy()

    taxa = 1.0 / max(np.median(np.diff(t)), 1e-3) if len(t) > 1 else 1.0
    suav = max(1, int(round(taxa)))  # ~1 s
    rumo_cont = np.unwrap(rumo)
    omega = _media_movel(np.gradient(rumo_cont, t), suav) if len(t) > 2 else np.zeros(len(t))
    acel_vertical = _media_movel(np.gradient(subida, t), suav) if len(t) > 2 else np.zeros(len(t))
    centripeta = vel * omega
    fator_carga = np.hypot(centripeta, G + acel_vertical) / G

    voando = va > velocidade_min_ms
    corda = area_m2 / envergadura_m
    pressao_dinamica = 0.5 * rho * va ** 2
    cl = np.where(voando, fator_carga * massa_kg * G / (pressao_dinamica * area_m2), np.nan)
    reynolds = np.where(voando, rho * va * corda / VISCOSIDADE_AR, np.nan)
    gama = np.degrees(np.arcsin(np.clip(subida / np.maximum(va, 0.1), -1, 1)))
    alfa = np.full(len(t), np.nan)
    if atitude is not None and len(atitude):
        pitch = np.interp(t, atitude["t"].to_numpy(), atitude["Pitch"].to_numpy())
        alfa = np.where(voando, pitch - gama, np.nan)
    potencia = np.full(len(t), np.nan)
    if bat is not None and len(bat) and "Curr" in bat.columns:
        tb = (bat["TimeUS"].to_numpy(dtype=np.int64) - origem) / 1e6
        p = bat["Volt"].to_numpy(dtype=float) * bat["Curr"].to_numpy(dtype=float)
        valida = np.isfinite(p)
        # Monitor só de tensão (Curr = NaN): potência fica "sem medição", não 0 W.
        if valida.any():
            potencia = np.interp(t, tb[valida], p[valida])
    return {
        "t": t, "vel_solo": vel, "vel_ar": np.where(voando, va, np.nan), "fator_carga": np.where(voando, fator_carga, np.nan),
        "cl": cl, "reynolds": reynolds, "alfa": alfa, "gama": np.where(voando, gama, np.nan),
        "potencia": potencia, "voando": voando, "corda_m": corda,
    }


def velocidade_estol(massa_kg, area_m2, rho, cl_max, fator_carga=1.0):
    return float(np.sqrt(2 * fator_carga * massa_kg * G / (rho * area_m2 * cl_max)))


def gps_em_movimento(dados, origem, inicio, fim, velocidade_min=3.0):
    """GPS instância 0, com fix, no trecho e acima de `velocidade_min`."""
    gps = dados.get("GPS")
    if gps is None or not len(gps) or "GCrs" not in gps.columns:
        return None
    gps = utils.filtrar_instancia(gps, "I")
    t = (gps["TimeUS"].to_numpy(dtype=np.int64) - origem) / 1e6
    gps = gps[(gps["Status"] >= 3) & (t >= inicio) & (t <= fim) & (gps["Spd"] > velocidade_min)]
    return gps.reset_index(drop=True) if len(gps) >= 5 else None
