import parser
from analysis import battery, gps, flight_performance, imu_vibration


def resumir_voo(caminho_bin, dados=None):
    """
    Lê um arquivo .bin e roda todos os módulos de análise disponíveis,
    consolidando tudo em um único dicionário de resumo do voo.

    Se alguma mensagem necessária não existir no log (ex: log sem
    VIBE), aquela seção fica de fora do resumo, mas o restante
    continua sendo calculado normalmente.

    Parâmetros
    ----------
    caminho_bin : str ou Path
        Caminho para o arquivo .bin.
    dados : dict[str, pandas.DataFrame], opcional
        Resultado de parser.ler_log() já carregado. Passe quando quem
        chama já leu o log, para não fazer o parsing duas vezes.

    Retorna
    -------
    dict
        Resumo consolidado do voo, com uma chave por categoria
        (bateria, gps, altitude, vibracao).
    """
    if dados is None:
        dados = parser.ler_log(caminho_bin)
    resumo = {"arquivo": str(caminho_bin)}

    if "BAT" in dados:
        try:
            resumo["bateria"] = battery.analisar(dados["BAT"])
        except Exception as erro:
            resumo["bateria"] = {"erro": str(erro)}

    if "GPS" in dados:
        try:
            resumo["gps"] = gps.analisar(dados["GPS"])
        except Exception as erro:
            resumo["gps"] = {"erro": str(erro)}

    # Altitude/taxa de subida: prioriza BARO (mais preciso na vertical),
    # cai para GPS só se o log não tiver BARO.
    if "BARO" in dados:
        try:
            resumo["altitude"] = flight_performance.analisar(dados["BARO"])
            resumo["altitude"]["fonte"] = "BARO"
        except Exception as erro:
            resumo["altitude"] = {"erro": str(erro)}
    elif "GPS" in dados:
        try:
            # Mesmo filtro de fix da análise de GPS: antes do fix a
            # altitude costuma vir zerada e viraria a referência do voo.
            gps_com_fix = dados["GPS"][dados["GPS"]["Status"] >= 3]
            resumo["altitude"] = flight_performance.analisar(gps_com_fix)
            resumo["altitude"]["fonte"] = "GPS (BARO indisponível)"
        except Exception as erro:
            resumo["altitude"] = {"erro": str(erro)}

    if "VIBE" in dados:
        try:
            resumo["vibracao"] = imu_vibration.analisar(dados["VIBE"])
        except Exception as erro:
            resumo["vibracao"] = {"erro": str(erro)}

    return resumo


def imprimir_resumo(resumo):
    """
    Imprime um resumo de voo (dict devolvido por resumir_voo) de forma
    legível no terminal.
    """
    print(f"Arquivo: {resumo['arquivo']}")
    for categoria, valores in resumo.items():
        if categoria == "arquivo":
            continue
        print(f"\n[{categoria.upper()}]")
        for chave, valor in valores.items():
            print(f"  {chave}: {valor}")


if __name__ == "__main__":
    # Rode a partir da raiz do projeto: python -m analysis.statistics
    import config

    arquivos_bin = list(config.PASTA_LOGS.glob("*.bin"))

    if not arquivos_bin:
        print(f"Nenhum arquivo .bin encontrado em {config.PASTA_LOGS}")
    else:
        for caminho in arquivos_bin:
            resumo = resumir_voo(caminho)
            imprimir_resumo(resumo)
            print("\n" + "=" * 60 + "\n")