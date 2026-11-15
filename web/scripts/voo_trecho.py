# Referência em Python para scripts/voo-trecho.ts (mesma lógica de preparar_trecho do dashboard).
import json, math, sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import parser as adam_parser
from analysis import statistics
from visualization import dados_voo

caminho = sys.argv[1]
completo = adam_parser.ler_log(caminho, usar_cache=False)
dados = {t: completo[t] for t in (*dados_voo.TIPOS_DO_PAINEL, "MSG") if t in completo}
origem = dados_voo.origem_us(completo)
# O painel do Python pega a origem do subconjunto de mensagens (3 ms de diferença no log real);
# o site usa a do log completo em tudo. Para comparar, a referência usa a mesma.
_origem_sub = dados_voo.origem_us(dados)
dados_voo.origem_us = lambda _d: origem
duracao = dados_voo.duracao_s(dados, origem)
tv = dados_voo.detectar_trecho_em_voo(dados, origem)
if len(sys.argv) > 2:
    ini, fim = float(sys.argv[2]), float(sys.argv[3])
else:
    ini, fim = (round(tv[0], 1), round(tv[1], 1)) if tv else (0.0, duracao)
janela = dados_voo.cortar_janela(dados, ini, fim, origem)
resumo = statistics.resumir_voo(caminho, dados=janela)
resumo.pop("arquivo")
am = dados_voo.altitude_maxima(dados, janela)
fonte = "BARO" if resumo.get("altitude", {}).get("fonte") == "BARO" else "GPS"
for cat, f in (("altitude", fonte), ("gps", "GPS")):
    if am[f] is not None and "altitude_maxima_m" in resumo.get(cat, {}):
        resumo[cat]["altitude_maxima_m"] = am[f]
painel = dados_voo.montar_painel(dados, ini, fim)
kml = dados_voo.gerar_kml(dados, ini, fim, "x")
def limpar(o):
    if isinstance(o, float) and not math.isfinite(o): return None
    if isinstance(o, dict): return {k: limpar(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)): return [limpar(v) for v in o]
    return o
print(json.dumps(limpar({"duracao": duracao, "trechoEmVoo": tv, "trecho": [ini, fim], "resumo": resumo, "painel": painel,
                         "origem_subset_igual": _origem_sub == origem})))
