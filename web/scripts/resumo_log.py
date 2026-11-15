# Mesmo resumo do resumo-log.ts, a partir do parser.py (referência).
import json, math, sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
import numpy as np
import pandas as pd
import parser as p
dados = p.ler_log(sys.argv[1], usar_cache=False)
saida = {}
for nome, df in dados.items():
    cols = {}
    for c in df.columns:
        v = df[c]
        if v.dtype == object and len(v) and not isinstance(v.iloc[0], str):
            todos = np.concatenate([np.asarray(x, dtype=np.float64) for x in v])
            cols[c] = ["arr", len(todos), float(todos.sum())]
        elif not pd.api.types.is_numeric_dtype(v):
            cols[c] = ["txt", v.iloc[0], v.iloc[-1]]
        else:
            a = v.to_numpy(dtype=np.float64)
            f = np.isfinite(a)
            cols[c] = [int(f.sum()), float(a[f].sum()), float(a[0]) if math.isfinite(a[0]) else None, float(a[-1]) if math.isfinite(a[-1]) else None,
                       "int" if pd.api.types.is_integer_dtype(v) else "float"]
    saida[nome] = {"n": len(df), "cols": cols}
print(json.dumps(saida))
