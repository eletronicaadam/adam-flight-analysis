# Dossiê pelo Python (referência), para comparar com scripts/dossie.ts.
#   python scripts/dossie_py.py LOG.bin [FICHA.toml]
import json, sys, pathlib
sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import parser as p
from analysis import dossie
dados = p.ler_log(sys.argv[1], usar_cache=False)
print(json.dumps(dossie.gerar_dossie(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None, dados=dados),
                 ensure_ascii=False))
