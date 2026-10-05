"""
dossie.py

Gera o "dossiê do voo": um JSON com tudo que o analista de voo precisa
para interpretar um log -- ficha da aeronave, informações do log, voos
detectados, resumo das métricas, eventos de segurança (com evidência e
instante) e a lista do que NÃO é confiável neste log.

Rode a partir da raiz do projeto:

    python -m analysis.dossie "data/logs/voo.bin"
    python -m analysis.dossie "data/logs/voo.bin" --saida dossie.json

Sem --saida, grava em data/cache/dossies/<nome do log>.json e imprime um
resumo legível.
"""

import argparse
import sys
import json
import math
from datetime import datetime
from pathlib import Path

import numpy as np

import config
import parser as adam_parser
from analysis import eventos as eventos_mod
from analysis import statistics
from analysis.ficha import carregar_ficha
from visualization import dados_voo as dv


def _limpar(valor):
    """Converte numpy/NaN para tipos que o JSON aceita."""
    if isinstance(valor, dict):
        return {str(k): _limpar(v) for k, v in valor.items()}
    if isinstance(valor, (list, tuple)):
        return [_limpar(v) for v in valor]
    if isinstance(valor, (np.integer,)):
        return int(valor)
    if isinstance(valor, (np.floating, float)):
        valor = float(valor)
        return round(valor, 4) if math.isfinite(valor) else None
    if isinstance(valor, np.bool_):
        return bool(valor)
    return valor


def _info_do_log(dados, origem):
    textos = dados["MSG"]["Message"].astype(str).tolist() if "MSG" in dados else []
    firmware = next((x for x in textos if x.startswith(("ArduPlane", "ArduCopter", "ArduRover", "ArduSub"))), None)
    placa = None
    if firmware:
        indice = textos.index(firmware)
        candidatos = [x for x in textos[indice + 1: indice + 4] if not x.startswith(("ChibiOS", "Param", "RC "))]
        placa = candidatos[0].split()[0] if candidatos else None
    parametros = {}
    if "PARM" in dados:
        parametros = dados["PARM"].drop_duplicates("Name", keep="last").set_index("Name")["Value"].to_dict()
    importantes = ["AHRS_ORIENTATION", "AHRS_EKF_TYPE", "ARSPD_TYPE", "ARSPD_USE", "BATT_MONITOR", "BATT_CAPACITY",
                   "COMPASS_USE", "THR_FAILSAFE", "FS_LONG_ACTN", "FS_SHORT_ACTN", "INS_LOG_BAT_MASK", "LOG_BITMASK",
                   "AIRSPEED_MIN", "AIRSPEED_CRUISE", "PTCH_LIM_MAX_DEG", "PTCH_LIM_MIN_DEG"]
    return {
        "firmware": firmware,
        "placa": placa,
        "duracao_s": round(dv.duracao_s(dados, origem), 1),
        "tipos_de_mensagem": {tipo: len(df) for tipo, df in sorted(dados.items())},
        "parametros_importantes": {k: parametros[k] for k in importantes if k in parametros},
    }


def gerar_dossie(caminho_bin, caminho_ficha=None, dados=None):
    """Monta o dossiê (dict) de um log."""
    caminho_bin = Path(caminho_bin)
    dados = dados if dados is not None else adam_parser.ler_log(caminho_bin)
    ficha = carregar_ficha(caminho_ficha)
    origem = dv.origem_us(dados)
    deteccao = eventos_mod.detectar(dados, ficha)

    resumos = []
    for voo in deteccao["voos"]:
        janela = dv.cortar_janela(dados, voo["inicio_s"], voo["fim_s"], origem)
        resumo = statistics.resumir_voo(caminho_bin, dados=janela)
        resumo.pop("arquivo", None)
        alt = dv.altitude_maxima(dados, janela)
        resumo["altitude_relativa_solo"] = {"maxima_barometro_m": alt["BARO"], "maxima_gps_m": alt["GPS"]}
        resumos.append({"voo": voo, "metricas": resumo})

    contagem = {g: sum(e["gravidade"] == g for e in deteccao["eventos"]) for g in eventos_mod.GRAVIDADES}
    if contagem["critico"]:
        veredito = "problemas críticos"
    elif contagem["atencao"]:
        veredito = "atenção"
    else:
        veredito = "voo normal"

    dossie = {
        "arquivo": caminho_bin.name,
        "gerado_em": datetime.now().isoformat(timespec="seconds"),
        "tempo": "segundos desde a primeira mensagem do log (mm:ss = minutos:segundos)",
        "ficha": {k: v for k, v in ficha.items() if not k.startswith("_")},
        "log": _info_do_log(dados, origem),
        "veredito_automatico": veredito,
        "contagem_eventos": contagem,
        "voos": resumos,
        "bateria": deteccao["bateria"],
        "atitude": deteccao["atitude"],
        "qualidade_dados": deteccao["qualidade_dados"],
        "eventos": deteccao["eventos"],
        "limites_usados": {k: {"valor": v[0], "fonte": v[1]} for k, v in eventos_mod.LIMITES.items()},
    }
    return _limpar(dossie)


def _mmss(s):
    if s is None:
        return "  —  "
    m, r = divmod(max(0.0, s), 60)
    return f"{int(m)}:{r:04.1f}"


def imprimir(dossie):
    print(f"Arquivo: {dossie['arquivo']}  |  {dossie['log']['firmware']}  |  {dossie['log']['placa']}")
    print(f"Veredito automático: {dossie['veredito_automatico'].upper()}  {dossie['contagem_eventos']}")
    for v in dossie["voos"]:
        voo = v["voo"]
        print(f"Voo: {_mmss(voo['inicio_s'])} → {_mmss(voo['fim_s'])} ({voo['duracao_s']} s, máx. {voo['velocidade_max_ms']} m/s)")
    print("\nO que não é confiável neste log:")
    for q in dossie["qualidade_dados"]:
        print(f"  - {q}")
    print("\nEventos:")
    marca = {"critico": "!!", "atencao": " !", "info": "  "}
    for e in dossie["eventos"]:
        print(f"  {marca[e['gravidade']]} {_mmss(e['inicio_s'])}  [{e['categoria']}] {e['titulo']}: {e['descricao']}")


def main():
    # Console do Windows (cp1252) não imprime "→", "°" etc.: força UTF-8.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    argumentos = argparse.ArgumentParser(description="Gera o dossiê de segurança de um log de voo.")
    argumentos.add_argument("log", help="arquivo .bin")
    argumentos.add_argument("--ficha", help="ficha da aeronave (padrão: aeronave.toml)")
    argumentos.add_argument("--saida", help="arquivo JSON de saída")
    argumentos.add_argument("--quieto", action="store_true", help="não imprime o resumo")
    a = argumentos.parse_args()

    dossie = gerar_dossie(a.log, a.ficha)
    saida = Path(a.saida) if a.saida else config.PASTA_CACHE / "dossies" / f"{Path(a.log).stem}.json"
    saida.parent.mkdir(parents=True, exist_ok=True)
    saida.write_text(json.dumps(dossie, ensure_ascii=False, indent=2), encoding="utf-8")
    if not a.quieto:
        imprimir(dossie)
    print(f"\nDossiê gravado em: {saida}")


if __name__ == "__main__":
    main()
