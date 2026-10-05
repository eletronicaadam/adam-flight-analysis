"""
ficha.py

Lê a ficha da aeronave (aeronave.toml na raiz do projeto): massa, asa,
bateria, propulsão e como a controladora está instalada. As análises usam
a ficha para limites de segurança (ex: tensão mínima por célula) e para
saber o que é confiável no log (ex: placa montada ao contrário).
"""

import tomllib
from pathlib import Path

import config

CAMINHO_PADRAO = config.PASTA_RAIZ / "aeronave.toml"

# Valores usados quando a ficha não existe ou não tem o campo.
PADRAO = {
    "nome": "",
    "massa_vazio_kg": None,
    "massa_decolagem_kg": None,
    "area_asa_m2": None,
    "envergadura_m": None,
    "bateria": {"celulas": None, "capacidade_mah": None, "tensao_minima_celula_v": 3.3},
    "controladora": {"funcao": "piloto_automatico", "orientacao": "normal", "calibrada": True},
    "propulsao": {"motor": "", "helice": "", "corrente_maxima_a": None},
}


def _mesclar(base, novo):
    resultado = dict(base)
    for chave, valor in novo.items():
        if isinstance(valor, dict) and isinstance(base.get(chave), dict):
            resultado[chave] = _mesclar(base[chave], valor)
        else:
            resultado[chave] = valor
    return resultado


def carregar_ficha(caminho=None):
    """
    Devolve a ficha como dicionário (com os valores padrão preenchendo o
    que faltar). Campos numéricos 0 ou vazios viram None ("não informado").
    """
    caminho = Path(caminho) if caminho else CAMINHO_PADRAO
    ficha = dict(PADRAO)
    if caminho.exists():
        with open(caminho, "rb") as arquivo:
            ficha = _mesclar(PADRAO, tomllib.load(arquivo))
    ficha["_arquivo"] = str(caminho) if caminho.exists() else None

    def limpar(d):
        for chave, valor in d.items():
            if isinstance(valor, dict):
                limpar(valor)
            elif isinstance(valor, (int, float)) and not isinstance(valor, bool) and valor == 0:
                d[chave] = None
            elif valor == "":
                d[chave] = None

    def preencher(d, padrao):
        # Texto com padrão (ex.: orientacao = "") volta ao padrão em vez de None.
        for chave, valor in padrao.items():
            if isinstance(valor, dict) and isinstance(d.get(chave), dict):
                preencher(d[chave], valor)
            elif d.get(chave) is None and valor not in (None, ""):
                d[chave] = valor
    limpar(ficha)
    preencher(ficha, PADRAO)
    return ficha


def versao_ficha(caminho=None):
    """Data de modificação da ficha (para expirar caches quando ela muda)."""
    caminho = Path(caminho) if caminho else CAMINHO_PADRAO
    return caminho.stat().st_mtime_ns if caminho.exists() else None


def controladora_comanda(ficha):
    """True se a controladora comanda os servos (modos/failsafes importam)."""
    return ficha["controladora"].get("funcao") != "registrador"
