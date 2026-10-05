"""
comum.py

Peças compartilhadas pelas abas do dashboard: carregamento do log em
cache, o "contexto" (arquivo + trecho escolhidos na barra lateral) e a
exibição do painel interativo com o retorno de "Analisar trecho do zoom".
"""

import math
from dataclasses import dataclass
from pathlib import Path

import streamlit as st

import parser as adam_parser
from visualization import dados_voo
from visualization.painel_voo import painel_voo


# cache_resource (e não cache_data): devolve o mesmo objeto sem copiar --
# copiar DataFrames grandes a cada interação deixaria a página lenta.
# Ninguém altera esses dados.
@st.cache_resource(max_entries=2, show_spinner=False)
def carregar_log(caminho_str, versao):
    """
    Só os tipos de mensagem da aba principal (leve). `versao` (tamanho,
    data) faz o cache expirar se o .bin mudar.
    """
    completo = adam_parser.ler_log(caminho_str)
    dados = {tipo: completo[tipo] for tipo in (*dados_voo.TIPOS_DO_PAINEL, "MSG") if tipo in completo}
    # Origem do log completo: a mesma das abas que usam todas as mensagens,
    # para o trecho [início, fim] valer igual em todas.
    origem = dados_voo.origem_us(completo)
    del completo
    return {
        "dados": dados,
        "origem": origem,
        "duracao": dados_voo.duracao_s(dados, origem),
        "trecho_em_voo": dados_voo.detectar_trecho_em_voo(dados, origem),
    }


# O log completo (todas as ~50 mensagens, incluindo IMU e EKF) só é
# carregado quando uma aba precisa dele, e só um fica em memória por vez.
@st.cache_resource(max_entries=1, show_spinner=False)
def carregar_log_completo(caminho_str, versao):
    dados = adam_parser.ler_log(caminho_str)
    return {
        "dados": dados,
        "origem": dados_voo.origem_us(dados),
        "unidades": dados_voo.unidades(dados),
    }


@dataclass
class Contexto:
    """Arquivo e trecho escolhidos na barra lateral."""
    caminho: Path
    versao: tuple
    inicio: float
    fim: float
    duracao: float
    log: dict

    @property
    def caminho_str(self):
        return str(self.caminho)

    @property
    def dados(self):
        return self.log["dados"]

    @property
    def origem(self):
        return self.log["origem"]

    def completo(self):
        with st.spinner("Carregando todas as mensagens do log... (só na primeira vez)"):
            return carregar_log_completo(self.caminho_str, self.versao)

    def id_painel(self, aba, *extra):
        """Identificador do conteúdo do painel: muda = painel se reconstrói."""
        return "|".join(map(str, (aba, self.caminho_str, self.versao, self.inicio, self.fim, *extra)))


def mmss(segundos):
    m, s = divmod(max(0.0, segundos), 60)
    return f"{int(m)}:{s:04.1f}"


def mostrar(valor, formato):
    """Formata uma métrica, ou None se ela não existir/for NaN."""
    if valor is None or (isinstance(valor, float) and not math.isfinite(valor)):
        return None
    return formato.format(valor)


def linha_de_metricas(metricas):
    """Métricas lado a lado que quebram linha em tela estreita."""
    with st.container(horizontal=True, wrap=True, gap="small"):
        for rotulo, valor, *ajuda in metricas:
            if valor is not None:
                st.metric(rotulo, valor, border=True, width="content", help=ajuda[0] if ajuda else None)


def mostrar_painel(payload, ctx, key):
    """
    Desenha o painel interativo e trata "Analisar trecho do zoom": o
    trecho pedido vale para todas as abas (é o slider da barra lateral).
    """
    retorno = painel_voo(payload, key=key)
    if (
        isinstance(retorno, dict)
        and retorno.get("acao") == "janela"
        and retorno.get("nonce") != st.session_state.get(f"ultimo_nonce::{key}")
    ):
        st.session_state[f"ultimo_nonce::{key}"] = retorno.get("nonce")
        st.session_state["trecho_pendente"] = (ctx.caminho_str, float(retorno["inicio"]), float(retorno["fim"]))
        st.rerun()
