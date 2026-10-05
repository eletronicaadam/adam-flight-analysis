import utils


def filtrar_imu(dados_vibe, instancia_imu=0):
    """
    Devolve as linhas de VIBE de uma instância de IMU. Firmwares antigos
    não têm a coluna "IMU" (uma linha por amostra, com Clip0/Clip1/Clip2),
    e nesse caso todas as linhas são da mesma série.
    """
    return utils.filtrar_instancia(dados_vibe, "IMU", instancia_imu)


def analisar(dados_vibe, instancia_imu=0):
    """
    Calcula métricas de vibração/saúde mecânica a partir do DataFrame
    de mensagens VIBE.

    Filtra pela instância de IMU indicada, já que FCs com mais de um
    IMU físico geram uma linha de VIBE por IMU -- misturar instâncias
    diferentes distorceria as estatísticas.

    Parâmetros
    ----------
    dados_vibe : pandas.DataFrame
        DataFrame com as colunas IMU, VibeX, VibeY, VibeZ, Clip
        (dados["VIBE"]).
    instancia_imu : int
        Qual IMU usar (0 é o principal/primário na maioria dos setups).

    Retorna
    -------
    dict
        Dicionário com as métricas calculadas.
    """
    vibe_filtrado = filtrar_imu(dados_vibe, instancia_imu)

    if vibe_filtrado.empty:
        raise ValueError(f"Nenhuma mensagem VIBE para a IMU {instancia_imu}.")

    vibe_x = vibe_filtrado["VibeX"]
    vibe_y = vibe_filtrado["VibeY"]
    vibe_z = vibe_filtrado["VibeZ"]

    # Clip é um contador acumulado, não um valor instantâneo -- por
    # isso pegamos só o último valor, não a soma de todas as linhas.
    # Logs antigos usam Clip0/Clip1/Clip2 (um por IMU) em vez de Clip.
    coluna_clip = "Clip" if "Clip" in vibe_filtrado.columns else f"Clip{instancia_imu}"
    clipping_total = int(vibe_filtrado[coluna_clip].iloc[-1])

    return {
        "vibe_x_media": float(vibe_x.mean()),
        "vibe_x_maxima": float(vibe_x.max()),
        "vibe_y_media": float(vibe_y.mean()),
        "vibe_y_maxima": float(vibe_y.max()),
        "vibe_z_media": float(vibe_z.mean()),
        "vibe_z_maxima": float(vibe_z.max()),
        "clipping_total": clipping_total,
    }


if __name__ == "__main__":
    # Rode a partir da raiz do projeto: python -m analysis.imu_vibration
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
                if "VIBE" not in dados:
                    print("  Este log não tem mensagens VIBE.")
                    continue
                resultado = analisar(dados["VIBE"])
                for chave, valor in resultado.items():
                    print(f"  {chave}: {valor}")
            except Exception as erro:
                print(f"  Erro: {erro}")
            print()