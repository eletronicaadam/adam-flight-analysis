from pathlib import Path

import pandas as pd

import config
from analysis import statistics


def exportar_mensagens_brutas(dados, nome_voo, pasta_destino=None):
    """
    Exporta cada tipo de mensagem (GPS, BAT, VIBE, etc.) como um CSV
    separado, dentro de uma subpasta com o nome do voo.
    """
    pasta_destino = Path(pasta_destino or config.PASTA_CSV)
    pasta_voo = pasta_destino / nome_voo
    pasta_voo.mkdir(parents=True, exist_ok=True)

    for tipo_mensagem, df in dados.items():
        caminho_csv = pasta_voo / f"{tipo_mensagem}.csv"
        df.to_csv(caminho_csv, index=False)

    print(f"Mensagens brutas exportadas em: {pasta_voo}")


def exportar_resumo_csv(caminho_bin, caminho_csv_historico=None, dados=None):
    """
    Roda o resumo de um voo (statistics.resumir_voo) e adiciona uma
    linha ao CSV histórico -- uma linha por voo processado, com todas
    as métricas "achatadas" em colunas (ex: bateria_consumo_mah,
    gps_distancia_percorrida_m).

    Se o voo já existir no histórico (mesmo nome de arquivo), a linha
    antiga é substituída pela nova.

    Passe `dados` (resultado de parser.ler_log) se o log já foi lido,
    para não refazer o parsing.
    """
    caminho_csv_historico = Path(
        caminho_csv_historico or (config.PASTA_CSV / "historico_voos.csv")
    )

    resumo = statistics.resumir_voo(caminho_bin, dados=dados)

    # Guarda só o nome do arquivo: o caminho completo muda de máquina
    # para máquina e quebraria a detecção de voo repetido.
    linha = {"arquivo": Path(resumo["arquivo"]).name}
    for categoria, valores in resumo.items():
        if categoria == "arquivo":
            continue
        for chave, valor in valores.items():
            linha[f"{categoria}_{chave}"] = valor

    linha_df = pd.DataFrame([linha])

    if caminho_csv_historico.exists():
        historico = pd.read_csv(caminho_csv_historico)
        # Compara pelo nome também nas linhas antigas, que podem ter sido
        # gravadas com o caminho completo.
        nomes_antigos = historico["arquivo"].astype(str).map(lambda c: Path(c).name)
        historico = historico[nomes_antigos != linha["arquivo"]]
        historico = pd.concat([historico, linha_df], ignore_index=True)
    else:
        historico = linha_df

    historico.to_csv(caminho_csv_historico, index=False)
    print(f"Resumo adicionado ao histórico: {caminho_csv_historico}")


if __name__ == "__main__":
    import parser as adam_parser

    arquivos_bin = list(config.PASTA_LOGS.glob("*.bin"))

    if not arquivos_bin:
        print(f"Nenhum arquivo .bin encontrado em {config.PASTA_LOGS}")
    else:
        for caminho in arquivos_bin:
            nome_voo = caminho.stem
            dados = adam_parser.ler_log(caminho)

            exportar_mensagens_brutas(dados, nome_voo)
            exportar_resumo_csv(caminho, dados=dados)