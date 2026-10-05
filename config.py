"""
config.py

Este arquivo guarda todos os caminhos de pasta e constantes usados pelo
resto do projeto. Nenhum outro arquivo deve escrever caminhos "na mão" --
todos devem importar as variáveis daqui.

Exemplo de uso em outro arquivo:

    import config
    caminho_do_bin = config.PASTA_LOGS / "voo01.bin"
"""

from pathlib import Path

# -----------------------------------------------------------------------
# Caminho raiz do projeto (calculado automaticamente a partir deste
# arquivo, então funciona independente de onde o projeto for executado)
# -----------------------------------------------------------------------
PASTA_RAIZ = Path(__file__).resolve().parent

# -----------------------------------------------------------------------
# Pastas de dados
# -----------------------------------------------------------------------
PASTA_DADOS = PASTA_RAIZ / "data"

PASTA_LOGS = PASTA_DADOS / "logs"      # arquivos .bin brutos
PASTA_CSV = PASTA_DADOS / "csv"        # CSVs exportados
PASTA_CACHE = PASTA_DADOS / "cache"    # cache do parsing (para não reprocessar)

# -----------------------------------------------------------------------
# Garante que as pastas existem. Se não existirem, cria automaticamente.
# Assim nenhum aluno precisa criar pasta manualmente.
# -----------------------------------------------------------------------
for pasta in [PASTA_LOGS, PASTA_CSV, PASTA_CACHE]:
    pasta.mkdir(parents=True, exist_ok=True)

# -----------------------------------------------------------------------
# Constantes físicas / de conversão, usadas em vários módulos de análise
# -----------------------------------------------------------------------
MICROSSEGUNDOS_POR_SEGUNDO = 1_000_000

# Mensagens do DataFlash que o software espera encontrar no log.
# Usado como referência ao verificar quais mensagens estão disponíveis
# em um determinado arquivo .bin (nem todo log tem todas elas).
MENSAGENS_ESPERADAS = [
    "GPS",
    "ATT",
    "BAT",
    "BARO",
    "VIBE",
    "IMU",
    "RCIN",
    "RCOU",
    "MODE",
    "RSSI",
    "PARM",
]
