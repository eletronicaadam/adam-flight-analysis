import plotly.express as px
import plotly.graph_objects as go

import utils
from analysis import imu_vibration

# Todos os gráficos usam só a instância 0 de cada sensor: com sensores
# redundantes as linhas vêm intercaladas e o traço ficaria em zigue-zague.


def grafico_altitude(dados_baro, instancia=0):
    """
    Gera um gráfico de altitude relativa ao longo do tempo.
    """
    dados_baro = utils.filtrar_instancia(dados_baro, "I", instancia)
    tempo_s = utils.tempo_em_segundos(dados_baro["TimeUS"])
    altitude_rel = utils.altitude_relativa(dados_baro["Alt"])

    fig = px.line(
        x=tempo_s,
        y=altitude_rel,
        labels={"x": "Tempo (s)", "y": "Altitude (m)"},
        title="Altitude x Tempo",
    )
    return fig


def grafico_bateria(dados_bat, instancia=0):
    """
    Gera um gráfico de tensão e corrente ao longo do tempo, em dois
    eixos Y (já que tensão e corrente têm escalas bem diferentes).
    """
    dados_bat = utils.filtrar_instancia(dados_bat, "Inst", instancia)
    tempo_s = utils.tempo_em_segundos(dados_bat["TimeUS"])

    fig = go.Figure()

    fig.add_trace(go.Scatter(
        x=tempo_s, y=dados_bat["Volt"],
        name="Tensão (V)", yaxis="y1",
    ))
    fig.add_trace(go.Scatter(
        x=tempo_s, y=dados_bat["Curr"],
        name="Corrente (A)", yaxis="y2",
    ))

    fig.update_layout(
        title="Tensão e Corrente x Tempo",
        xaxis=dict(title="Tempo (s)"),
        yaxis=dict(title="Tensão (V)"),
        yaxis2=dict(title="Corrente (A)", overlaying="y", side="right"),
    )
    return fig


def grafico_potencia(dados_bat, instancia=0):
    """
    Gera um gráfico só da potência (Volt x Curr) ao longo do tempo,
    em um único eixo Y -- útil quando se quer focar na potência sem a
    escala dupla do gráfico combinado de tensão/corrente.
    """
    dados_bat = utils.filtrar_instancia(dados_bat, "Inst", instancia)
    tempo_s = utils.tempo_em_segundos(dados_bat["TimeUS"])
    potencia_w = dados_bat["Volt"] * dados_bat["Curr"]

    fig = px.line(
        x=tempo_s,
        y=potencia_w,
        labels={"x": "Tempo (s)", "y": "Potência (W)"},
        title="Potência x Tempo",
    )
    return fig


def grafico_vibracao(dados_vibe, instancia_imu=0):
    """
    Gera um gráfico de vibração (VibeX/Y/Z) ao longo do tempo, para
    uma instância de IMU específica.
    """
    vibe_filtrado = imu_vibration.filtrar_imu(dados_vibe, instancia_imu)
    tempo_s = utils.tempo_em_segundos(vibe_filtrado["TimeUS"])

    fig = go.Figure()
    for eixo, cor in [("VibeX", "red"), ("VibeY", "green"), ("VibeZ", "blue")]:
        fig.add_trace(go.Scatter(
            x=tempo_s, y=vibe_filtrado[eixo], name=eixo, line=dict(color=cor),
        ))

    fig.update_layout(
        title="Vibração x Tempo",
        xaxis_title="Tempo (s)",
        yaxis_title="Vibração (m/s²)",
    )
    return fig