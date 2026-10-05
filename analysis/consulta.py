"""
consulta.py

Consulta rápida de valores do log em um trecho de tempo -- usada pelo
analista de voo para conferir evidências, e útil para qualquer pessoa no
terminal.

    python -m analysis.consulta LOG --listar
    python -m analysis.consulta LOG --tipo BAT --campos Volt,Curr --inicio 630 --fim 641
    python -m analysis.consulta LOG --tipo ATITUDE --inicio 635 --fim 642 --passo 0.5
    python -m analysis.consulta LOG --mensagens --inicio 600 --fim 650

O tempo é em segundos desde a primeira mensagem do log (o mesmo do
dossiê e do dashboard). --passo reduz a tabela a uma linha a cada N
segundos. O tipo especial ATITUDE devolve a atitude recalculada da IMU
(usando a orientação da ficha / detectada), útil quando o ATT gravado não
é confiável.
"""

import argparse
import sys

import numpy as np
import pandas as pd

import parser as adam_parser
from analysis import atitude as atitude_mod
from analysis.ficha import carregar_ficha
from visualization import dados_voo as dv


def _tabela(df, origem, inicio, fim, campos, passo, instancia):
    t = dv.segundos(df, origem)
    df = df.assign(t=np.round(t, 2))
    for coluna in ("I", "Inst", "IMU", "C"):
        if instancia is not None and coluna in df.columns:
            df = df[df[coluna] == instancia]
            break
    df = df[(df["t"] >= inicio) & (df["t"] <= fim)]
    if passo and len(df):
        grupo = ((df["t"] - inicio) // passo).astype(int)
        df = df.groupby(grupo).first()
    colunas = ["t"] + (campos or [c for c in df.columns if c not in ("t", "TimeUS")])
    faltando = [c for c in colunas if c not in df.columns]
    if faltando:
        raise SystemExit(f"Campos inexistentes: {faltando}. Disponíveis: {list(df.columns)}")
    return df[colunas]


def main():
    # Console do Windows (cp1252) não imprime "→", "°" etc.: força UTF-8.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    a = argparse.ArgumentParser(description="Consulta valores de um log em um trecho de tempo.")
    a.add_argument("log")
    a.add_argument("--listar", action="store_true", help="lista tipos de mensagem e colunas")
    a.add_argument("--tipo", help="tipo de mensagem (GPS, BAT, VIBE...) ou ATITUDE")
    a.add_argument("--campos", help="colunas separadas por vírgula (padrão: todas)")
    a.add_argument("--inicio", type=float, default=0.0)
    a.add_argument("--fim", type=float, default=float("inf"))
    a.add_argument("--passo", type=float, default=0.0, help="uma linha a cada N segundos")
    a.add_argument("--instancia", type=int, default=0, help="instância do sensor (padrão 0; -1 = todas)")
    a.add_argument("--mensagens", action="store_true", help="mostra as mensagens de texto (MSG/ERR) do trecho")
    a.add_argument("--max-linhas", type=int, default=200)
    x = a.parse_args()

    dados = adam_parser.ler_log(x.log)
    origem = dv.origem_us(dados)
    pd.set_option("display.width", 200)
    pd.set_option("display.max_columns", 30)

    if x.listar:
        for tipo, df in sorted(dados.items()):
            print(f"{tipo:6} {len(df):>8} linhas  {', '.join(map(str, df.columns))}")
        return
    if x.mensagens:
        for tipo in ("MSG", "ERR", "EV", "MODE"):
            if tipo in dados:
                print(f"--- {tipo} ---")
                print(_tabela(dados[tipo], origem, x.inicio, x.fim, None, 0, None).to_string(index=False))
        return
    if not x.tipo:
        raise SystemExit("Use --tipo, --mensagens ou --listar.")

    campos = x.campos.split(",") if x.campos else None
    instancia = None if x.instancia < 0 else x.instancia
    if x.tipo.upper() == "ATITUDE":
        ficha = carregar_ficha()
        deteccao = atitude_mod.detectar_orientacao(dados, origem)
        orientacao = atitude_mod.orientacao_efetiva(dados, ficha, deteccao)
        fim = x.fim if np.isfinite(x.fim) else None
        # ~60 s antes do trecho para o filtro convergir (como em atitude_confiavel)
        df = atitude_mod.reprocessar_atitude(dados, orientacao, max(0.0, x.inicio - 60), fim)
        if df is None:
            raise SystemExit("Sem dados de IMU suficientes neste trecho para recalcular a atitude.")
        print(f"# atitude recalculada da IMU (orientação: {orientacao})")
        instancia = None
    else:
        if x.tipo not in dados:
            raise SystemExit(f"O log não tem {x.tipo}. Use --listar.")
        df = dados[x.tipo]
    tabela = _tabela(df, origem, x.inicio, x.fim, campos, x.passo, instancia)
    if len(tabela) > x.max_linhas:
        print(f"# {len(tabela)} linhas; mostrando {x.max_linhas} (use --passo para resumir)")
        tabela = tabela.iloc[np.linspace(0, len(tabela) - 1, x.max_linhas).astype(int)]
    print(tabela.round(3).to_string(index=False))


if __name__ == "__main__":
    main()
