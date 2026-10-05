"""
parser.py

Responsável por ler um arquivo .bin do DataFlash (ArduPilot) e devolver
os dados organizados em um dicionário de DataFrames do pandas, um por
tipo de mensagem (GPS, BAT, ATT, VIBE, etc.).

Uso básico:

    import parser as adam_parser
    dados = adam_parser.ler_log("data/logs/voo01.bin")
    dados["GPS"]   # DataFrame com as colunas TimeUS, Lat, Lng, Alt, Spd...
    dados["BAT"]   # DataFrame com as colunas TimeUS, Volt, Curr...
"""

import os
import pickle
import re
import sys
import uuid
from pathlib import Path

import numpy as np
import pandas as pd
from pymavlink import DFReader, mavutil

import config

# Incrementar quando o formato do resultado de ler_log mudar, para
# invalidar caches antigos automaticamente.
_VERSAO_CACHE = 2

# Sobra máxima (bytes) no fim do arquivo sem mensagens indexadas. O próprio
# DFReader tolera até 528 bytes de lixo no fim de um log; mais que isso
# indica um trecho corrompido no meio, onde o índice parou.
_SOBRA_MAXIMA_FIM = 528

# Tipo do numpy equivalente a cada código do módulo struct usado pelo
# DFReader (todos little-endian, como no arquivo .bin).
_NUMPY_POR_STRUCT = {
    "b": "i1", "B": "u1", "h": "<i2", "H": "<u2", "i": "<i4", "I": "<u4",
    "q": "<i8", "Q": "<u8", "e": "<f2", "f": "<f4", "d": "<f8",
}


def _caminho_cache(caminho_bin):
    """
    Nome do arquivo de cache para um .bin. Inclui tamanho e data de
    modificação, então se o .bin for substituído o cache antigo é
    simplesmente ignorado.
    """
    info = caminho_bin.stat()
    nome = f"{caminho_bin.stem}_{info.st_size}_{info.st_mtime_ns}_v{_VERSAO_CACHE}.pkl"
    return config.PASTA_CACHE / nome


def ler_log(caminho_bin, usar_cache=True):
    """
    Lê um arquivo .bin do DataFlash e devolve um dicionário de DataFrames.

    O parsing de um .bin é lento (pode levar dezenas de segundos em
    voos longos), então o resultado é guardado em data/cache/ e
    reaproveitado nas próximas leituras do mesmo arquivo.

    Parâmetros
    ----------
    caminho_bin : str ou Path
        Caminho para o arquivo .bin a ser lido.
    usar_cache : bool
        Se False, sempre refaz o parsing (e não grava cache).

    Retorna
    -------
    dict[str, pandas.DataFrame]
        Um DataFrame por tipo de mensagem encontrado no log.
        Exemplo: {"GPS": DataFrame(...), "BAT": DataFrame(...), ...}
    """
    caminho_bin = Path(caminho_bin)

    if not caminho_bin.exists():
        raise FileNotFoundError(
            f"Arquivo não encontrado: {caminho_bin}. "
            "Confira se o .bin está na pasta correta (data/logs/)."
        )

    if usar_cache:
        caminho_cache = _caminho_cache(caminho_bin)
        if caminho_cache.exists():
            try:
                with open(caminho_cache, "rb") as arquivo:
                    return pickle.load(arquivo)
            except Exception:
                # Cache corrompido (ex: execução interrompida no meio da
                # gravação) -- refaz o parsing normalmente.
                pass

    dados = _ler_log_bin(caminho_bin)

    if usar_cache:
        _gravar_cache(caminho_bin, caminho_cache, dados)

    return dados


def _gravar_cache(caminho_bin, caminho_cache, dados):
    """
    Grava o cache sem nunca derrubar uma leitura que deu certo: se a
    gravação falhar (disco cheio, outro processo gravando ao mesmo tempo),
    só avisa. Usa um arquivo temporário com nome único e renomeia, para
    nunca deixar um cache pela metade.
    """
    temporario = caminho_cache.with_name(
        f"{caminho_cache.stem}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp"
    )
    try:
        with open(temporario, "wb") as arquivo:
            pickle.dump(dados, arquivo, protocol=pickle.HIGHEST_PROTOCOL)
        temporario.replace(caminho_cache)
    except Exception as erro:
        print(f"Aviso: não foi possível gravar o cache ({erro!r}).", file=sys.stderr)
        try:
            temporario.unlink(missing_ok=True)
        except OSError:
            pass
        return

    # Apaga caches antigos do mesmo arquivo (outro tamanho/data ou versão).
    padrao = re.compile(rf"^{re.escape(caminho_bin.stem)}_\d+_\d+_v\d+\.pkl$")
    for antigo in config.PASTA_CACHE.iterdir():
        if antigo != caminho_cache and padrao.match(antigo.name):
            try:
                antigo.unlink()
            except OSError:
                pass


def _ler_log_bin(caminho_bin):
    """
    Faz o parsing de fato do .bin (sem cache).

    Em vez de criar um objeto Python por mensagem (lento: logs reais têm
    milhões de mensagens), usa o índice de posições que o DFReader monta
    ao abrir o arquivo e decodifica cada tipo de mensagem de uma vez só,
    com numpy. Se algo der errado, cai para a leitura mensagem a mensagem,
    que é mais lenta mas sempre funciona.
    """
    try:
        return _ler_log_bin_vetorizado(caminho_bin)
    except Exception as erro:
        print(
            f"Aviso: leitura rápida falhou ({erro!r}); usando a leitura "
            "mensagem a mensagem.",
            file=sys.stderr,
        )
        return _ler_log_bin_mensagem_a_mensagem(caminho_bin)


def _dtype_do_formato(fmt):
    """
    Monta o dtype do numpy que corresponde ao corpo de uma mensagem
    (sem os 3 bytes de cabeçalho). Devolve None se o formato tiver algum
    campo que não dá para decodificar em bloco.
    """
    campos = []
    for i, codigo in enumerate(fmt.format):
        codigo_struct = DFReader.FORMAT_TO_STRUCT[codigo][0]
        if codigo_struct.endswith("s"):
            tipo_numpy = f"S{int(codigo_struct[:-1])}"
        else:
            tipo_numpy = _NUMPY_POR_STRUCT[codigo_struct]
        campos.append((f"c{i}", tipo_numpy))
    dtype = np.dtype(campos)
    if dtype.itemsize != fmt.len - 3:
        return None
    return dtype


def _texto(valor_bytes):
    """Mesma conversão de texto que o DFReader faz (utf-8, senão latin-1)."""
    try:
        texto = valor_bytes.decode("utf-8")
    except UnicodeDecodeError:
        texto = valor_bytes.decode("ISO-8859-1")
    return texto.split("\0", 1)[0]


def _decodificar_tipo(memoria, offsets, fmt, dtype):
    """Decodifica todas as mensagens de um tipo em um DataFrame."""
    tamanho_corpo = fmt.len - 3
    offsets = np.asarray(offsets, dtype=np.int64)
    # Descarta mensagem cortada no fim do arquivo (comum em logs reais).
    offsets = offsets[offsets + fmt.len <= len(memoria)]

    # Copia o corpo de cada mensagem para um bloco contíguo, um byte de
    # coluna por vez (usa pouca memória extra mesmo com milhões de linhas).
    corpos = np.empty((len(offsets), tamanho_corpo), dtype=np.uint8)
    inicio = offsets + 3
    for j in range(tamanho_corpo):
        corpos[:, j] = memoria[inicio + j]
    registros = corpos.view(dtype).reshape(-1)

    colunas = {}
    for i, nome in enumerate(fmt.columns[: len(fmt.format)]):
        codigo = fmt.format[i]
        bruto = registros[f"c{i}"]
        tipo_python = DFReader.FORMAT_TO_STRUCT[codigo][2]
        multiplicador = fmt.msg_mults[i]

        if codigo in "nNZ":
            valores = [_texto(v) for v in bruto.tolist()]
        elif tipo_python is float or multiplicador is not None:
            valores = bruto.astype(np.float64)
            if multiplicador is not None:
                # Igual ao DFReader: dividir por 1e2/1e7 é mais preciso
                # do que multiplicar por 1e-2/1e-7.
                if 0.0 < multiplicador < 1.0:
                    valores = valores / (1 / multiplicador)
                else:
                    valores = valores * multiplicador
        elif codigo == "Q" and len(bruto) and bruto.max() > np.iinfo(np.int64).max:
            # Valor acima do limite do int64 (ex: máscara de 64 bits):
            # mantém como inteiro do Python, igual ao DFReader.
            valores = bruto.astype(object)
        else:
            valores = bruto.astype(np.int64)
        colunas[nome] = valores

    return pd.DataFrame(colunas)


def _linha_da_mensagem(msg):
    """
    Igual a msg.to_dict() (sem "mavpackettype"), mas tolera FMT com mais
    nomes de coluna do que campos -- caso em que to_dict() quebra.
    """
    fmt = msg.fmt
    return {coluna: getattr(msg, coluna) for coluna in fmt.columns[: len(fmt.format)]}


def _definicoes_por_tipo(log, memoria):
    """
    Lê todas as mensagens FMT do log e devolve {tipo_id: [(offset, DFFormat)]}
    só para os tipos definidos mais de uma vez com formatos diferentes
    (logs concatenados, ids reaproveitados por scripts). O DFReader guarda
    só a última definição, então esses tipos precisam ser decodificados
    em partes, cada uma com a definição que valia naquele trecho.
    """
    fmt_fmt = log.formats[0x80]
    offsets_fmt = np.asarray(log.offsets[0x80], dtype=np.int64)
    offsets_fmt = offsets_fmt[offsets_fmt + fmt_fmt.len <= len(memoria)]
    tabela = _decodificar_tipo(memoria, offsets_fmt, fmt_fmt, _dtype_do_formato(fmt_fmt))
    tabela["offset"] = offsets_fmt

    redefinidos = {}
    campos = ["Length", "Name", "Format", "Columns"]
    for tipo_id, grupo in tabela.groupby("Type"):
        if len(grupo.drop_duplicates(campos)) < 2:
            continue
        definicoes = []
        for _, linha in grupo.iterrows():
            try:
                fmt = DFReader.DFFormat(int(tipo_id), linha["Name"], int(linha["Length"]),
                                        linha["Format"], linha["Columns"])
            except Exception:
                fmt = None
            definicoes.append((int(linha["offset"]), fmt))
        redefinidos[int(tipo_id)] = definicoes
    return redefinidos


def _ler_log_bin_vetorizado(caminho_bin):
    log = DFReader.DFReader_binary(str(caminho_bin), zero_time_base=False)
    try:
        # O arquivo é lido para a memória do numpy (e não pelo mmap do
        # DFReader): assim nenhuma referência ao mmap impede de fechá-lo,
        # mesmo se der erro no meio.
        memoria = np.fromfile(str(caminho_bin), dtype=np.uint8)

        # O índice do DFReader para no primeiro trecho corrompido do
        # arquivo. Se sobrou muita coisa sem indexar, a leitura rápida
        # perderia o resto do voo -- melhor usar a leitura lenta, que
        # pula o trecho ruim e continua.
        fim_indexado = 0
        for tipo_id, offsets in enumerate(log.offsets):
            if len(offsets) and tipo_id in log.formats:
                fim_indexado = max(fim_indexado, int(offsets[-1]) + log.formats[tipo_id].len)
        if log.data_len - fim_indexado > _SOBRA_MAXIMA_FIM:
            raise ValueError(
                f"índice cobre só {fim_indexado} de {log.data_len} bytes "
                "(provável trecho corrompido no log)"
            )

        redefinidos = _definicoes_por_tipo(log, memoria)
        partes = {}          # nome -> lista de DataFrames
        tipos_lentos = []
        for tipo_id, offsets in enumerate(log.offsets):
            if len(offsets) == 0 or tipo_id not in log.formats:
                continue
            offsets = np.asarray(offsets, dtype=np.int64)
            if tipo_id in redefinidos:
                # Cada trecho do arquivo usa a definição FMT mais recente.
                definicoes = redefinidos[tipo_id]
                segmentos = []
                for k, (inicio, fmt) in enumerate(definicoes):
                    fim = definicoes[k + 1][0] if k + 1 < len(definicoes) else len(memoria)
                    segmentos.append((fmt, offsets[(offsets > inicio) & (offsets < fim)]))
            else:
                segmentos = [(log.formats[tipo_id], offsets)]

            for fmt, offs in segmentos:
                if fmt is None or len(offs) == 0:
                    continue
                # Arrays ("a") e o conteúdo de arquivos (FILE) têm conversões
                # especiais no DFReader -- ficam para a leitura lenta.
                especial = "a" in fmt.format or fmt.name == "FILE"
                dtype = None if especial else _dtype_do_formato(fmt)
                if dtype is None:
                    if tipo_id not in redefinidos:
                        tipos_lentos.append(fmt.name)
                    continue
                df = _decodificar_tipo(memoria, offs, fmt, dtype)
                if len(df):
                    partes.setdefault(fmt.name, []).append(df)
        memoria = None

        dados = {
            nome: (dfs[0] if len(dfs) == 1 else pd.concat(dfs, ignore_index=True))
            for nome, dfs in partes.items()
        }

        if tipos_lentos:
            log.rewind()
            linhas_por_tipo = {}
            while True:
                msg = log.recv_match(type=tipos_lentos, strict=True)
                if msg is None:
                    break
                linhas_por_tipo.setdefault(msg.get_type(), []).append(_linha_da_mensagem(msg))
            for tipo, linhas in linhas_por_tipo.items():
                dados[tipo] = pd.DataFrame(linhas)
    finally:
        log.close()

    if not dados:
        raise ValueError(
            f"Nenhuma mensagem foi decodificada de {caminho_bin}. "
            "Verifique se o arquivo é um .bin válido do ArduPilot."
        )

    return dict(sorted(dados.items()))


def _ler_log_bin_mensagem_a_mensagem(caminho_bin):
    """Leitura lenta, uma mensagem por vez (usada como alternativa)."""
    # Abre o log. mavutil.mavlink_connection detecta automaticamente que
    # é um arquivo DataFlash (.bin) e usa o DFReader por trás dos panos.
    log = mavutil.mavlink_connection(str(caminho_bin))

    # Dicionário temporário: cada chave é o tipo da mensagem (ex: "GPS"),
    # e o valor é uma lista de dicionários (uma entrada por mensagem lida).
    mensagens_por_tipo = {}

    try:
        while True:
            msg = log.recv_msg()

            # recv_msg devolve None quando chega ao fim do arquivo
            if msg is None:
                break

            tipo = msg.get_type()

            # Mensagens de erro interno do próprio pymavlink não são dados de
            # voo -- ignoramos para não poluir o resultado.
            if tipo == "BAD_DATA":
                continue

            linha = _linha_da_mensagem(msg)

            linhas = mensagens_por_tipo.get(tipo)
            if linhas is None:
                linhas = mensagens_por_tipo[tipo] = []
            linhas.append(linha)
    finally:
        # Libera o arquivo (no Windows, um .bin aberto não pode ser
        # movido/apagado). Nem toda versão do DFReader tem close().
        fechar = getattr(log, "close", None)
        if fechar is not None:
            fechar()

    # Converte cada lista de dicionários em um DataFrame do pandas.
    dados = {
        tipo: pd.DataFrame(linhas) for tipo, linhas in mensagens_por_tipo.items()
    }

    if not dados:
        raise ValueError(
            f"Nenhuma mensagem foi decodificada de {caminho_bin}. "
            "Verifique se o arquivo é um .bin válido do ArduPilot."
        )

    return dados


def listar_mensagens_disponiveis(dados):
    """
    Mostra quais tipos de mensagem foram encontrados no log e quantas
    linhas cada um tem. Útil para conferir rapidamente o que tem
    disponível em um determinado voo, já que nem todo log tem todas
    as mensagens.

    Parâmetros
    ----------
    dados : dict[str, pandas.DataFrame]
        O dicionário devolvido por ler_log().
    """
    print(f"{'Mensagem':<10} {'Linhas':>10}")
    print("-" * 22)
    for tipo in sorted(dados.keys()):
        print(f"{tipo:<10} {len(dados[tipo]):>10}")


if __name__ == "__main__":
    # Pequeno teste manual: roda `python parser.py` para conferir que o
    # parsing está funcionando com um .bin de exemplo na pasta de logs.
    arquivos_bin = list(config.PASTA_LOGS.glob("*.bin"))

    if not arquivos_bin:
        print(f"Nenhum arquivo .bin encontrado em {config.PASTA_LOGS}")
        print("Coloque um arquivo .bin de teste nessa pasta e rode novamente.")
    else:
        caminho_teste = arquivos_bin[0]
        print(f"Lendo: {caminho_teste.name}\n")

        dados = ler_log(caminho_teste)
        listar_mensagens_disponiveis(dados)

        print("\nExemplo -- primeiras linhas de GPS (se disponível):")
        if "GPS" in dados:
            print(dados["GPS"].head())
        else:
            print("Este log não contém mensagens GPS.")
