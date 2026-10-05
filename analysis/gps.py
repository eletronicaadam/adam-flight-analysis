import utils


def analisar(dados_gps, instancia=0):
    """
    Calcula as métricas principais de posição/trajetória a partir do
    DataFrame de mensagens GPS.

    Filtra automaticamente apenas as linhas com fix 3D ou melhor
    (Status >= 3: 3D, DGPS, RTK float, RTK fixo), já que leituras sem
    fix confiável distorcem completamente os cálculos de distância e
    altitude (comum nos primeiros segundos após ligar o equipamento,
    antes do GPS estabilizar).

    Com dois receptores, as linhas de cada um vêm intercaladas (coluna
    "I"); só a instância indicada é usada, senão a distância somaria os
    "saltos" entre as posições dos dois receptores.

    Parâmetros
    ----------
    dados_gps : pandas.DataFrame
        DataFrame com as colunas TimeUS, Lat, Lng, Alt, Spd, Status,
        HDop, NSats (dados["GPS"]).

    Retorna
    -------
    dict
        Dicionário com as métricas calculadas.
    """
    dados_gps = utils.filtrar_instancia(dados_gps, "I", instancia)
    total_linhas = len(dados_gps)

    gps_confiavel = dados_gps[dados_gps["Status"] >= 3].reset_index(drop=True)
    linhas_confiaveis = len(gps_confiavel)

    if linhas_confiaveis < 2:
        raise ValueError(
            "Este log não tem fix 3D suficiente para calcular métricas de "
            "trajetória. Verifique a qualidade do GPS durante o voo."
        )

    tempo_s = utils.tempo_em_segundos(gps_confiavel["TimeUS"])
    duracao_s = float(tempo_s.iloc[-1])

    alt_rel = utils.altitude_relativa(gps_confiavel["Alt"])

    distancia_m = utils.distancia_percorrida_metros(
        gps_confiavel["Lat"], gps_confiavel["Lng"]
    )

    return {
        "duracao_s": duracao_s,
        "distancia_percorrida_m": distancia_m,
        "altitude_maxima_m": float(alt_rel.max()),
        "velocidade_maxima_ms": float(gps_confiavel["Spd"].max()),
        "velocidade_media_ms": float(gps_confiavel["Spd"].mean()),
        "hdop_medio": float(gps_confiavel["HDop"].mean()),
        "satelites_media": float(gps_confiavel["NSats"].mean()),
        "percentual_fix_3d": (linhas_confiaveis / total_linhas) * 100,
    }


if __name__ == "__main__":
    # Rode a partir da raiz do projeto: python -m analysis.gps
    import config
    import parser

    arquivos_bin = list(config.PASTA_LOGS.glob("*.bin"))

    if not arquivos_bin:
        print(f"Nenhum arquivo .bin encontrado em {config.PASTA_LOGS}")
    else:
        for caminho in arquivos_bin:
            print(f"--- {caminho.name} ---")
            try:
                dados = parser.ler_log(caminho)
                resultado = analisar(dados["GPS"])
                for chave, valor in resultado.items():
                    print(f"  {chave}: {valor:.2f}")
            except Exception as erro:
                print(f"  Erro: {erro}")
            print()