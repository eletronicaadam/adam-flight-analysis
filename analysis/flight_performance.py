import utils


def analisar(dados_baro, janela_s=1.0, instancia=0):
    """
    Calcula métricas de performance vertical de voo (altitude máxima,
    taxa de subida/descida) a partir do DataFrame de mensagens BARO.

    Os dados são agrupados em janelas de tempo (padrão: 1 segundo)
    antes de calcular a taxa de subida/descida, para suavizar o ruído
    natural do sensor barométrico -- calcular a derivada ponto a ponto
    em dados brutos gera picos irreais de taxa vertical.

    Parâmetros
    ----------
    dados_baro : pandas.DataFrame
        DataFrame com as colunas TimeUS, Alt (dados["BARO"]). Também
        funciona com dados["GPS"], já que essa também tem TimeUS e Alt,
        caso o log não tenha BARO.
    janela_s : float
        Tamanho da janela de suavização, em segundos.
    instancia : int
        Qual barômetro (ou GPS) usar, pela coluna "I". Com mais de um
        sensor as linhas vêm intercaladas e não podem ser misturadas.

    Retorna
    -------
    dict
        Dicionário com as métricas calculadas.
    """
    dados_baro = utils.filtrar_instancia(dados_baro, "I", instancia)

    if len(dados_baro) < 2:
        raise ValueError("Mensagens de altitude insuficientes para análise.")

    tempo_s = utils.tempo_em_segundos(dados_baro["TimeUS"])
    altitude = dados_baro["Alt"]

    duracao_s = float(tempo_s.iloc[-1])
    altitude_rel = utils.altitude_relativa(altitude)

    grupo = (tempo_s // janela_s).astype(int)
    tempo_agrupado = tempo_s.groupby(grupo).mean()
    altitude_agrupada = altitude.groupby(grupo).mean()

    delta_altitude = altitude_agrupada.diff()
    delta_tempo = tempo_agrupado.diff()
    taxa_vertical_ms = delta_altitude / delta_tempo

    return {
        "duracao_s": duracao_s,
        "altitude_maxima_m": float(altitude_rel.max()),
        # Limitado a zero: se o voo nunca desceu, a menor taxa ainda é
        # uma subida e não pode virar "descida" (e vice-versa).
        "taxa_subida_maxima_ms": float(max(0.0, taxa_vertical_ms.max())),
        "taxa_descida_maxima_ms": float(max(0.0, -taxa_vertical_ms.min())),
    }


if __name__ == "__main__":
    # Rode a partir da raiz do projeto: python -m analysis.flight_performance
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
                if "BARO" not in dados:
                    print("  Este log não tem mensagens BARO.")
                    continue
                resultado = analisar(dados["BARO"])
                for chave, valor in resultado.items():
                    print(f"  {chave}: {valor:.2f}")
            except Exception as erro:
                print(f"  Erro: {erro}")
            print()