import numpy as np
import config

def filtrar_instancia(df, coluna, instancia=0):
    """
    Mantém só as linhas de uma instância de sensor (ex: GPS "I", BARO "I",
    BAT "Inst", VIBE "IMU"). Logs com mais de um sensor intercalam as
    linhas de cada instância -- misturar instâncias distorce integrais,
    distâncias e derivadas. Se o log não tiver a coluna (firmware antigo
    ou sensor único), devolve o DataFrame inteiro.
    """
    if coluna not in df.columns:
        return df
    return df[df[coluna] == instancia].reset_index(drop=True)

def tempo_em_segundos(serie_timeus):
    tempo_relativo_us = serie_timeus - serie_timeus.iloc[0]
    return tempo_relativo_us / config.MICROSSEGUNDOS_POR_SEGUNDO

def altitude_relativa(serie_altitude):
    return serie_altitude - serie_altitude.iloc[0]

def integrar_no_tempo(serie_valor, serie_tempo_segundos):
    funcao_integracao = getattr(np, "trapezoid", None) or np.trapz
    return float(funcao_integracao(serie_valor, serie_tempo_segundos))

def distancia_haversine_metros(lat1, lng1, lat2, lng2):
    raio_terra_m = 6_371_000

    lat1_rad, lng1_rad = np.radians(lat1), np.radians(lng1)
    lat2_rad, lng2_rad = np.radians(lat2), np.radians(lng2)

    delta_lat = lat2_rad - lat1_rad
    delta_lng = lng2_rad - lng1_rad

    a = (
        np.sin(delta_lat / 2) ** 2
        + np.cos(lat1_rad) * np.cos(lat2_rad) * np.sin(delta_lng / 2) ** 2
    )
    c = 2 * np.arcsin(np.sqrt(a))

    return raio_terra_m * c

def distancia_percorrida_metros(serie_lat, serie_lng):
    lat = serie_lat.to_numpy()
    lng = serie_lng.to_numpy()

    distancias = distancia_haversine_metros(lat[:-1], lng[:-1], lat[1:], lng[1:])

    return float(np.sum(distancias))