"""
validar.py — confere o site contra o Python (a referência) em todos os logs
de teste: para cada log roda os dois lados e compara o JSON de saída.

    .venv\\Scripts\\python web/scripts/validar.py            (logs de tests/ e data/logs/)
    .venv\\Scripts\\python web/scripts/validar.py voo.bin    (só os logs dados)

Partes comparadas: parser (contagem/soma/primeiro/último de cada coluna e
tipo inteiro), aba Voo, dossiê (eventos, voos, métricas) e as abas Saúde,
Vibração, Aerodinâmica, Replay 3D e Explorador. Números com tolerância
relativa de 1e-6; textos exatos.

Os voos sintéticos (tests/voos_sinteticos) usam a ficha aeronave_teste.toml;
os demais, o aeronave.toml.
"""

import json
import math
import os
import subprocess
import sys
import tempfile
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[2]
WEB = RAIZ / "web"
SCRIPTS = WEB / "scripts"
PYTHON = sys.executable
TSX = str(WEB / "node_modules" / ".bin" / ("tsx.cmd" if os.name == "nt" else "tsx"))
FICHA_TESTE = RAIZ / "tests" / "voos_sinteticos" / "aeronave_teste.toml"

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def rodar(cmd, saida):
    with open(saida, "w", encoding="utf-8") as f:
        r = subprocess.run(cmd, stdout=f, stderr=subprocess.PIPE, cwd=WEB, text=True, encoding="utf-8")
    if r.returncode:
        raise RuntimeError(f"{' '.join(map(str, cmd))} falhou:\n{r.stderr[-2000:]}")
    with open(saida, encoding="utf-8") as f:
        return json.load(f)


def perto(a, b):
    if isinstance(a, bool) or isinstance(b, bool):
        return a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return math.isclose(a, b, rel_tol=1e-6, abs_tol=1e-6)
    return a == b


def diferencas(a, b, ignorar=(), caminho=""):
    """Lista de diferenças entre dois JSON (dicionários sem ordem, números com tolerância)."""
    difs = []
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            if k in ignorar:
                continue
            if k not in a or k not in b:
                difs.append(f"{caminho}.{k}: só em {'Python' if k in a else 'site'}")
            else:
                difs += diferencas(a[k], b[k], ignorar, f"{caminho}.{k}")
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            difs.append(f"{caminho}: {len(a)} itens x {len(b)}")
        for i, (p, q) in enumerate(zip(a, b)):
            difs += diferencas(p, q, ignorar, f"{caminho}[{i}]")
    elif not perto(a, b):
        difs.append(f"{caminho}: {json.dumps(a, ensure_ascii=False)[:120]} x {json.dumps(b, ensure_ascii=False)[:120]}")
    return difs


def diferencas_parser(a, b):
    difs = [f"tipo {k}: só em {'Python' if k in a else 'site'}" for k in sorted(set(a) ^ set(b))]
    for k in sorted(set(a) & set(b)):
        if a[k]["n"] != b[k]["n"]:
            difs.append(f"{k}: {a[k]['n']} linhas x {b[k]['n']}")
            continue
        if list(a[k]["cols"]) != list(b[k]["cols"]):
            difs.append(f"{k}: colunas diferentes")
        for c, x in a[k]["cols"].items():
            y = b[k]["cols"].get(c)
            if y is None:
                continue
            igual = x == y if "txt" in (x[0], y[0]) else (
                len(x) == len(y) and x[0] == y[0] and all(perto(p, q) for p, q in zip(x[1:], y[1:])))
            if not igual:
                difs.append(f"{k}.{c}: {x} x {y}")
    return difs


def validar(log, pasta):
    sintetico = log.parent.name == "voos_sinteticos"
    ficha = str(FICHA_TESTE) if sintetico else "-"
    nome = log.stem
    o = lambda lado, parte: pasta / f"{nome}_{parte}_{lado}.json"
    resultado = {}

    py = rodar([PYTHON, "-I", SCRIPTS / "resumo_log.py", log], o("py", "parser"))
    ts = rodar([TSX, SCRIPTS / "resumo-log.ts", log], o("ts", "parser"))
    resultado["parser"] = diferencas_parser(py, ts)

    ts = rodar([TSX, SCRIPTS / "voo-trecho.ts", log], o("ts", "voo"))
    ini, fim = map(str, ts["trecho"])
    py = rodar([PYTHON, "-I", SCRIPTS / "voo_trecho.py", log, ini, fim], o("py", "voo"))
    py.pop("origem_subset_igual", None)
    resultado["aba Voo"] = diferencas(py, ts, ignorar=("kml_len", "id", "arquivo"))

    args_ficha = [] if ficha == "-" else [ficha]
    py = rodar([PYTHON, "-I", SCRIPTS / "dossie_py.py", log, *args_ficha], o("py", "dossie"))
    ts = rodar([TSX, SCRIPTS / "dossie.ts", log, *args_ficha], o("ts", "dossie"))
    resultado["dossiê"] = diferencas(py, ts, ignorar=("gerado_em",))

    ts = rodar([TSX, SCRIPTS / "abas.ts", log, ficha], o("ts", "abas"))
    ini, fim = map(str, ts["trecho"])
    py = rodar([PYTHON, "-I", SCRIPTS / "abas_py.py", log, ficha, ini, fim], o("py", "abas"))
    resultado["outras abas"] = diferencas(py, ts)
    return resultado


def main():
    logs = [Path(x).resolve() for x in sys.argv[1:]] or [
        *sorted((RAIZ / "tests" / "voos_sinteticos").glob("*.bin")), *sorted((RAIZ / "data" / "logs").glob("*.bin"))]
    if not logs:
        sys.exit("Nenhum log encontrado. Gere os sintéticos: python tests/gerar_voo_sintetico.py --todos tests/voos_sinteticos")
    total = 0
    with tempfile.TemporaryDirectory() as tmp:
        for log in logs:
            print(f"\n{log.name}", flush=True)
            for parte, difs in validar(log, Path(tmp)).items():
                total += len(difs)
                print(f"  {parte:12} {'ok' if not difs else f'{len(difs)} diferença(s)'}", flush=True)
                for d in difs[:10]:
                    print(f"      {d}")
    print(f"\n{len(logs)} log(s), {total} diferença(s) no total.")
    sys.exit(1 if total else 0)


if __name__ == "__main__":
    main()
