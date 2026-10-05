import sys
from pathlib import Path

import matplotlib

# Backend sem interface gráfica: só gera arquivos PNG. Evita abrir/
# inicializar Tk à toa e funciona em servidor/thread (ex: Streamlit).
matplotlib.use("Agg")
import matplotlib.pyplot as plt

sys.path.append(str(Path(__file__).resolve().parent.parent))

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Image
from reportlab.lib.styles import getSampleStyleSheet

import config
import parser as adam_parser
import utils
from analysis import imu_vibration, statistics


def _grafico_matplotlib(tempo_s, valor, titulo, rotulo_y, caminho_saida):
    """
    Gera um gráfico simples com matplotlib e salva como imagem PNG,
    para ser inserida no PDF (o PDF não suporta gráficos interativos
    como os do dashboard, então usamos imagens estáticas aqui).
    """
    figura, eixo = plt.subplots(figsize=(6, 3))
    eixo.plot(tempo_s, valor)
    eixo.set_title(titulo)
    eixo.set_xlabel("Tempo (s)")
    eixo.set_ylabel(rotulo_y)
    figura.tight_layout()
    figura.savefig(caminho_saida, dpi=120)
    plt.close(figura)


def gerar_pdf(caminho_bin, caminho_saida_pdf):
    """
    Gera um relatório PDF de um voo, com as métricas principais e
    alguns gráficos, a partir do arquivo .bin.
    """
    caminho_bin = Path(caminho_bin)
    dados = adam_parser.ler_log(caminho_bin)
    resumo = statistics.resumir_voo(caminho_bin, dados=dados)

    pasta_temp = config.PASTA_CACHE / "temp_graficos"
    pasta_temp.mkdir(parents=True, exist_ok=True)

    estilos = getSampleStyleSheet()
    elementos = []

    elementos.append(Paragraph(f"Relatório de Voo — {caminho_bin.name}", estilos["Title"]))
    elementos.append(Spacer(1, 0.5 * cm))

    for categoria, valores in resumo.items():
        if categoria == "arquivo":
            continue
        elementos.append(Paragraph(categoria.upper(), estilos["Heading2"]))
        for chave, valor in valores.items():
            if isinstance(valor, float):
                valor_texto = f"{valor:.2f}"
            else:
                valor_texto = str(valor)
            elementos.append(Paragraph(f"{chave}: {valor_texto}", estilos["Normal"]))
        elementos.append(Spacer(1, 0.3 * cm))

    # Os gráficos usam só a instância 0 de cada sensor: com sensores
    # redundantes as linhas vêm intercaladas e o traço ficaria em zigue-zague.
    baro0 = utils.filtrar_instancia(dados["BARO"], "I") if "BARO" in dados else None
    if baro0 is not None and not baro0.empty:
        caminho_img = pasta_temp / "altitude.png"
        tempo_s = utils.tempo_em_segundos(baro0["TimeUS"])
        altitude_rel = utils.altitude_relativa(baro0["Alt"])
        _grafico_matplotlib(tempo_s, altitude_rel, "Altitude x Tempo", "Altitude (m)", caminho_img)
        elementos.append(Image(str(caminho_img), width=16 * cm, height=8 * cm))

    vibe0 = imu_vibration.filtrar_imu(dados["VIBE"]) if "VIBE" in dados else None
    if vibe0 is not None and not vibe0.empty:
        caminho_img = pasta_temp / "vibracao.png"
        tempo_s = utils.tempo_em_segundos(vibe0["TimeUS"])
        _grafico_matplotlib(tempo_s, vibe0["VibeZ"], "Vibração (eixo Z) x Tempo", "Vibração (m/s²)", caminho_img)
        elementos.append(Image(str(caminho_img), width=16 * cm, height=8 * cm))

    documento = SimpleDocTemplate(str(caminho_saida_pdf), pagesize=A4)
    documento.build(elementos)

    print(f"PDF gerado em: {caminho_saida_pdf}")


if __name__ == "__main__":
    arquivos_bin = list(config.PASTA_LOGS.glob("*.bin"))

    if not arquivos_bin:
        print(f"Nenhum arquivo .bin encontrado em {config.PASTA_LOGS}")
    else:
        caminho_teste = arquivos_bin[0]
        caminho_pdf = config.PASTA_RAIZ / "relatorio_teste.pdf"
        gerar_pdf(caminho_teste, caminho_pdf)