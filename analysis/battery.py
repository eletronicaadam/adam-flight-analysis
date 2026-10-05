import utils


def analisar(dados_bat, instancia=0):
    """
    Calcula métricas elétricas (tensão, corrente, potência, consumo) a
    partir do DataFrame de mensagens BAT.

    Logs com mais de uma bateria/monitor intercalam linhas de cada
    instância (coluna "Inst"); só a instância indicada é usada, senão a
    integração da corrente no tempo misturaria as duas baterias.
    """
    dados_bat = utils.filtrar_instancia(dados_bat, "Inst", instancia)

    if len(dados_bat) < 2:
        raise ValueError("Mensagens BAT insuficientes para calcular consumo.")

    tempo_s = utils.tempo_em_segundos(dados_bat["TimeUS"])

    tensao = dados_bat["Volt"]
    corrente = dados_bat["Curr"]

    potencia = tensao * corrente

    # Monitores só de tensão gravam a corrente como NaN, e uma amostra NaN
    # isolada estragaria a integral inteira: integra só as amostras com
    # tensão e corrente válidas (sem nenhuma, consumo fica NaN).
    validas = tensao.notna() & corrente.notna()
    if validas.sum() >= 2:
        consumo_as = utils.integrar_no_tempo(corrente[validas], tempo_s[validas])
        energia_ws = utils.integrar_no_tempo(potencia[validas], tempo_s[validas])
    else:
        consumo_as = energia_ws = float("nan")

    consumo_ah = consumo_as / 3600
    consumo_mah = consumo_ah * 1000
    consumo_wh = energia_ws / 3600

    return {
        "tensao_minima_v": float(tensao.min()),
        "tensao_maxima_v": float(tensao.max()),
        "corrente_maxima_a": float(corrente.max()),
        "corrente_media_a": float(corrente.mean()),
        "potencia_maxima_w": float(potencia.max()),
        "potencia_media_w": float(potencia.mean()),
        "consumo_mah": float(consumo_mah),
        "consumo_wh": float(consumo_wh),
    }


if __name__ == "__main__":
    # Rode a partir da raiz do projeto: python -m analysis.battery
    import config
    import parser

    arquivos_bin = list(config.PASTA_LOGS.glob("*.bin"))

    if not arquivos_bin:
        raise FileNotFoundError(f"Nenhum arquivo .bin encontrado em {config.PASTA_LOGS}")

    arquivo = arquivos_bin[0]
    print(f"Analisando: {arquivo.name}")

    dados = parser.ler_log(arquivo)

    resultado = analisar(dados["BAT"])

    for chave, valor in resultado.items():
        print(f"{chave}: {valor:.3f}")
