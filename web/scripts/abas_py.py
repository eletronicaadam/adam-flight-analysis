# Saída das abas pelo Streamlit (referência), para comparar com scripts/abas.ts.
#   python scripts/abas_py.py LOG FICHA|- INI FIM
import json, math, sys, pathlib, logging, warnings
sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
logging.disable(logging.CRITICAL); warnings.filterwarnings("ignore")
import numpy as np
import analysis.ficha as fichamod
if sys.argv[2] != "-":
    fichamod.CAMINHO_PADRAO = pathlib.Path(sys.argv[2])
from analysis import dossie
from visualization import dados_voo
from visualization.abas import saude, vibracao, aerodinamica, replay, explorador, comum

caminho, ini, fim = sys.argv[1], float(sys.argv[3]), float(sys.argv[4])
versao = ("v",)
completo = comum.carregar_log_completo(caminho, versao)
ficha = fichamod.carregar_ficha()

def caixa(fase, v):
    q1, q3 = np.percentile(v, 25), np.percentile(v, 75); iqr = q3 - q1
    d = v[(v >= q1 - 1.5 * iqr) & (v <= q3 + 1.5 * iqr)]
    return {"fase": fase, "n": len(v), "q1": q1, "mediana": np.percentile(v, 50), "q3": q3, "min": v.min(), "max": v.max(),
            "inferior": d.min(), "superior": d.max()}

quadro, painel, msgs = saude._preparar(caminho, versao, ini, fim)
painel.pop("id"); painel.pop("arquivo")
msg_ts = None
if msgs is not None:
    m = completo["dados"]["MSG"]; tt = dados_voo.segundos(m, completo["origem"]); dentro = (tt >= ini) & (tt <= fim)
    msg_ts = [{"instante": i, "t": x, "mensagem": s} for i, x, s in zip(msgs["instante"], tt[dentro], msgs["mensagem"])]

v = vibracao._preparar(caminho, versao, ini, fim, "imu")
if v["painel"]: v["painel"].pop("id"); v["painel"].pop("arquivo")
if v["fases"] is not None:
    f = v["fases"].dropna()
    v["fases"] = [caixa(n, f.loc[f["fase"] == n, "vibracao"].to_numpy()) for n in ("Solo, motor parado", "Solo, motor ligado", "Em movimento / voo")
         if (f["fase"] == n).any()]
if v["espectro"]:
    from analysis import espectro
    v["espectro"]["picos"] = espectro.picos(v["espectro"]["freq"], np.max(v["espectro"]["eixos"], axis=0))
if v["espectrograma"]:
    g = v["espectrograma"]; v["espectrograma"] = {"t": g["t"], "freq": g["freq"], "db_soma": float(g["db"].sum())}
v["temBatch"] = bool(vibracao._lotes(caminho, versao))

massa, area, env = ficha.get("massa_decolagem_kg") or 5.0, ficha.get("area_asa_m2") or 1.0, ficha.get("envergadura_m") or 2.0
vp = aerodinamica._vento_do_trecho(caminho, versao, ini, fim)
usar = bool(vp and vp["confiavel"])
a = aerodinamica._preparar(caminho, versao, ini, fim, massa, area, env, 25.0, usar, None)
if a:
    a["painel"].pop("id"); a["painel"].pop("arquivo")
    d = a.pop("dispersao"); a["dispersao"] = {k: d[k].tolist() for k in ("cl", "alfa", "vel_ar", "potencia", "n", "t")}
    a["usouVento"] = usar
    a["estol"] = [{"cl_max": c, "nivelado": aerodinamica.aero.velocidade_estol(massa, area, a["rho"], c),
                   "curva30": aerodinamica.aero.velocidade_estol(massa, area, a["rho"], c) * np.sqrt(1 / np.cos(np.radians(30))),
                   "curva45": aerodinamica.aero.velocidade_estol(massa, area, a["rho"], c) * np.sqrt(1 / np.cos(np.radians(45)))}
                  for c in aerodinamica.CL_MAX_REFERENCIA]
    a["carga_alar"] = massa / area

janela = dados_voo.cortar_janela(completo["dados"], ini, fim, completo["origem"])
div = dados_voo.divergencia_altitude(janela, completo["origem"], dados_voo.referencias_altitude(completo["dados"]))
ruim = bool(div and div["p95_m"] > dados_voo.DIVERGENCIA_ALTITUDE_M)
rp = replay._preparar(caminho, versao, ini, fim, "GPS" if ruim else "barômetro", None); rp.pop("id")

op, linhas = explorador._opcoes(caminho, versao)
pe = explorador._painel(caminho, versao, ini, fim, tuple(o for o in explorador.PADRAO if o in op), "Um gráfico por campo", 0, True)
pe.pop("id"); pe.pop("arquivo")

saida = {"trecho": [ini, fim], "saude": {"quadro": quadro, "painel": painel, "mensagens": msg_ts}, "vibracao": v, "aero": a,
         "replay": {"barometro_ruim": ruim, "payload": rp}, "explorador": {"opcoes": op, "linhas": linhas, "painel": pe}}

def conv(x):
    if isinstance(x, np.ndarray): return conv(x.tolist())
    if isinstance(x, dict): return {str(k): conv(y) for k, y in x.items()}
    if isinstance(x, (list, tuple)): return [conv(y) for y in x]
    if isinstance(x, (np.bool_,)): return bool(x)
    if isinstance(x, (np.integer,)): return int(x)
    return x
print(json.dumps(dossie._limpar(conv(saida)), ensure_ascii=False))
