"""
atitude.py

Recalcula a atitude (roll, pitch, yaw) a partir dos sensores brutos (IMU),
corrigindo a orientação de montagem da controladora. Serve para logs em
que a placa estava montada ao contrário ou não calibrada: nesses casos o
ATT/AHR2 gravados pelo ArduPilot estão errados, mas o giroscópio e o
acelerômetro continuam medindo o movimento real -- só nos eixos trocados.

Método: filtro complementar (Mahony) com quatérnio.
- O giroscópio (sem o bias medido no solo) integra a rotação.
- O acelerômetro corrige roll/pitch apontando a gravidade. Em voo, o
  acelerômetro também sente as acelerações da manobra; elas são
  descontadas usando a aceleração calculada pela velocidade do GPS
  (como faz o DCM do ArduPilot).
- Sem bússola, o yaw é corrigido pelo rumo do GPS quando o avião anda.

O resultado é uma ESTIMATIVA: use para entender o voo, sabendo que erros
de alguns graus são normais (vento, derrapagem, GPS a 5-10 Hz).
"""

import math

import numpy as np
import pandas as pd

import utils

G = 9.80665

# Rotação de cada montagem: converte eixos da placa -> eixos do avião
# (x para a frente, y para a direita, z para baixo).
ORIENTACOES = {
    "normal": np.diag([1.0, 1.0, 1.0]),
    "invertida_180": np.diag([-1.0, -1.0, 1.0]),   # seta para trás (Yaw180)
}

# Ganho da correção pelo acelerômetro (rad/s por unidade de erro) e do yaw
# pelo rumo GPS. Valores baixos = confia mais no giroscópio.
KP_GRAVIDADE = 0.6
KP_RUMO = 0.3
VELOCIDADE_MIN_RUMO_MS = 5.0


def _segundos(df, origem):
    return (df["TimeUS"].to_numpy(dtype=np.int64) - origem) / 1e6


def _quat_para_euler(q0, q1, q2, q3):
    roll = math.atan2(2 * (q0 * q1 + q2 * q3), 1 - 2 * (q1 * q1 + q2 * q2))
    pitch = math.asin(max(-1.0, min(1.0, 2 * (q0 * q2 - q3 * q1))))
    yaw = math.atan2(2 * (q0 * q3 + q1 * q2), 1 - 2 * (q2 * q2 + q3 * q3))
    return roll, pitch, yaw


def _euler_para_quat(roll, pitch, yaw):
    cr, sr = math.cos(roll / 2), math.sin(roll / 2)
    cp, sp = math.cos(pitch / 2), math.sin(pitch / 2)
    cy, sy = math.cos(yaw / 2), math.sin(yaw / 2)
    return (cr * cp * cy + sr * sp * sy, sr * cp * cy - cr * sp * sy,
            cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy)


def _aceleracao_gps(gps, origem):
    """Aceleração NED (m/s²) a partir da velocidade do GPS, por instante."""
    t = _segundos(gps, origem)
    rumo = np.radians(gps["GCrs"].to_numpy(dtype=np.float64))
    vel = gps["Spd"].to_numpy(dtype=np.float64)
    vn, ve = vel * np.cos(rumo), vel * np.sin(rumo)
    vd = gps["VZ"].to_numpy(dtype=np.float64) if "VZ" in gps.columns else np.zeros(len(gps))
    if len(t) < 3:
        return t, np.zeros((len(t), 3)), vel, rumo
    acc = np.column_stack([np.gradient(vn, t), np.gradient(ve, t), np.gradient(vd, t)])
    # Suaviza (GPS a 5-10 Hz derivado é ruidoso): média móvel de ~1 s.
    janela = max(1, int(round(1.0 / max(np.median(np.diff(t)), 1e-3))))
    if janela > 1:
        nucleo = np.ones(janela) / janela
        acc = np.column_stack([np.convolve(acc[:, k], nucleo, mode="same") for k in range(3)])
    return t, acc, vel, rumo


def reprocessar_atitude(dados, orientacao="normal", inicio_s=None, fim_s=None, instancia_imu=0):
    """
    Recalcula roll/pitch/yaw (graus) a partir de IMU + GPS.

    Parâmetros
    ----------
    dados : dict[str, DataFrame]  (resultado de parser.ler_log)
    orientacao : "normal" ou "invertida_180" (como a placa está montada)
    inicio_s, fim_s : trecho em segundos desde o início do log (opcional)

    Retorna um DataFrame com TimeUS, t (s), Roll, Pitch, Yaw, ou None se
    o log não tiver IMU.
    """
    if orientacao not in ORIENTACOES:
        raise ValueError(f"Orientação desconhecida: {orientacao}. Use uma de {list(ORIENTACOES)}.")
    imu = dados.get("IMU")
    if imu is None or not len(imu):
        return None
    imu = utils.filtrar_instancia(imu, "I", instancia_imu)
    origem = min(int(df["TimeUS"].min()) for df in dados.values() if "TimeUS" in df.columns and len(df))
    t = _segundos(imu, origem)
    selecao = np.ones(len(t), dtype=bool)
    if inicio_s is not None:
        selecao &= t >= inicio_s
    if fim_s is not None:
        selecao &= t <= fim_s
    imu, t = imu[selecao], t[selecao]
    if len(imu) < 10:
        return None

    R = ORIENTACOES[orientacao]
    gyr = imu[["GyrX", "GyrY", "GyrZ"]].to_numpy(dtype=np.float64) @ R.T
    acc = imu[["AccX", "AccY", "AccZ"]].to_numpy(dtype=np.float64) @ R.T

    # GPS: aceleração para compensar manobras e rumo para o yaw.
    gps = dados.get("GPS")
    tem_gps = gps is not None and len(gps) and "GCrs" in gps.columns
    if tem_gps:
        gps = utils.filtrar_instancia(gps, "I")
        gps = gps[gps["Status"] >= 3]
        tem_gps = len(gps) >= 3
    if tem_gps:
        tg, acc_gps, vel_gps, rumo_gps = _aceleracao_gps(gps, origem)
        acc_ned = np.column_stack([np.interp(t, tg, acc_gps[:, k], left=0, right=0) for k in range(3)])
        vel = np.interp(t, tg, vel_gps, left=0, right=0)
        # rumo interpolado pelo seno/cosseno (evita o salto 359°->0°)
        rumo = np.arctan2(np.interp(t, tg, np.sin(rumo_gps)), np.interp(t, tg, np.cos(rumo_gps)))
    else:
        acc_ned = np.zeros((len(t), 3))
        vel = np.zeros(len(t))
        rumo = np.zeros(len(t))

    # Bias do giroscópio: média com o avião parado (velocidade GPS baixa e
    # giroscópio quieto). Sem isso o yaw/roll derivam rápido.
    parado = (vel < 0.5) & (np.linalg.norm(gyr, axis=1) < 0.05)
    bias = np.median(gyr[parado], axis=0) if parado.sum() > 50 else np.zeros(3)
    gyr = gyr - bias

    # Atitude inicial: roll/pitch pela gravidade nas primeiras amostras.
    a0 = acc[: min(50, len(acc))].mean(axis=0)
    roll0 = math.atan2(-a0[1], -a0[2])
    pitch0 = math.atan2(a0[0], math.hypot(a0[1], a0[2]))
    q0, q1, q2, q3 = _euler_para_quat(roll0, pitch0, float(rumo[0]))

    n = len(t)
    saida = np.empty((n, 3))
    dts = np.diff(t, prepend=t[0])
    for i in range(n):
        dt = dts[i]
        gx, gy, gz = gyr[i]
        ax, ay, az = acc[i]
        if 0 < dt < 0.5:
            # Gravidade "medida" no corpo: R^T·a_ned - acc_medida = R^T·g.
            # R^T (NED -> corpo) a partir do quatérnio:
            r11 = 1 - 2 * (q2 * q2 + q3 * q3); r12 = 2 * (q1 * q2 + q0 * q3); r13 = 2 * (q1 * q3 - q0 * q2)
            r21 = 2 * (q1 * q2 - q0 * q3); r22 = 1 - 2 * (q1 * q1 + q3 * q3); r23 = 2 * (q2 * q3 + q0 * q1)
            r31 = 2 * (q1 * q3 + q0 * q2); r32 = 2 * (q2 * q3 - q0 * q1); r33 = 1 - 2 * (q1 * q1 + q2 * q2)
            an, ae, ad = acc_ned[i]
            mx = r11 * an + r12 * ae + r13 * ad - ax
            my = r21 * an + r22 * ae + r23 * ad - ay
            mz = r31 * an + r32 * ae + r33 * ad - az
            norma = math.sqrt(mx * mx + my * my + mz * mz)
            ex = ey = ez = 0.0
            # Só confia no acelerômetro quando a gravidade medida tem
            # módulo plausível (descarta impactos e vibração forte).
            if 0.7 * G < norma < 1.3 * G:
                mx, my, mz = mx / norma, my / norma, mz / norma
                # Gravidade estimada no corpo = terceira coluna de R^T.
                vx, vy, vz = r13, r23, r33
                # erro = medido × estimado
                ex = my * vz - mz * vy
                ey = mz * vx - mx * vz
                ez = mx * vy - my * vx
                ex, ey, ez = ex * KP_GRAVIDADE, ey * KP_GRAVIDADE, ez * KP_GRAVIDADE
            if vel[i] > VELOCIDADE_MIN_RUMO_MS:
                # Correção de yaw pelo rumo do GPS, aplicada no eixo vertical
                # do mundo expresso no corpo (r13, r23, r33).
                _, _, yaw = _quat_para_euler(q0, q1, q2, q3)
                erro_yaw = (rumo[i] - yaw + math.pi) % (2 * math.pi) - math.pi
                ex += KP_RUMO * erro_yaw * r13
                ey += KP_RUMO * erro_yaw * r23
                ez += KP_RUMO * erro_yaw * r33
            gx, gy, gz = gx + ex, gy + ey, gz + ez
            # Integra o quatérnio.
            dq0 = 0.5 * (-q1 * gx - q2 * gy - q3 * gz)
            dq1 = 0.5 * (q0 * gx + q2 * gz - q3 * gy)
            dq2 = 0.5 * (q0 * gy - q1 * gz + q3 * gx)
            dq3 = 0.5 * (q0 * gz + q1 * gy - q2 * gx)
            q0, q1, q2, q3 = q0 + dq0 * dt, q1 + dq1 * dt, q2 + dq2 * dt, q3 + dq3 * dt
            norma_q = math.sqrt(q0 * q0 + q1 * q1 + q2 * q2 + q3 * q3)
            q0, q1, q2, q3 = q0 / norma_q, q1 / norma_q, q2 / norma_q, q3 / norma_q
        saida[i] = _quat_para_euler(q0, q1, q2, q3)

    graus = np.degrees(saida)
    return pd.DataFrame({
        "TimeUS": imu["TimeUS"].to_numpy(),
        "t": t,
        "Roll": graus[:, 0],
        "Pitch": graus[:, 1],
        "Yaw": graus[:, 2] % 360,
    })


def orientacao_efetiva(dados, ficha, deteccao):
    """
    Orientação a aplicar nos dados da IMU. A detecção pela física vale
    primeiro (ela olha os dados já girados pela controladora). A da ficha
    (montagem física) só vale se AHRS_ORIENTATION = 0: se o parâmetro foi
    configurado, a IMU gravada já sai corrigida e girar de novo erraria.
    """
    if deteccao.get("orientacao"):
        return deteccao["orientacao"]
    da_ficha = ficha["controladora"].get("orientacao") or "normal"
    parm = dados.get("PARM")
    if da_ficha != "normal" and parm is not None and len(parm):
        configurada = parm.loc[parm["Name"] == "AHRS_ORIENTATION", "Value"]
        if len(configurada) and int(configurada.iloc[-1]) != 0:
            return "normal"
    return da_ficha


def atitude_confiavel(dados, ficha, origem, inicio_s=None, fim_s=None):
    """
    Escolhe a melhor atitude disponível para o trecho:
    - recalculada da IMU quando a placa está montada fora da posição
      (detectado pela física ou indicado na ficha) ou não calibrada;
    - senão, a gravada pelo ArduPilot (ATT).
    Devolve (DataFrame com t/Roll/Pitch/Yaw, descrição da fonte) ou
    (None, motivo).
    """
    deteccao = detectar_orientacao(dados, origem)
    orientacao = orientacao_efetiva(dados, ficha, deteccao)
    precisa_recalcular = orientacao != "normal" or not ficha["controladora"].get("calibrada", True)
    if precisa_recalcular and "IMU" in dados:
        # começa um pouco antes para o filtro convergir
        inicio = None if inicio_s is None else max(0.0, inicio_s - 60)
        df = reprocessar_atitude(dados, orientacao, inicio, fim_s)
        if df is not None:
            return df, f"recalculada da IMU (placa {orientacao.replace('_', ' ')})"
    att = dados.get("ATT")
    if att is not None and len(att):
        t = (att["TimeUS"].to_numpy(dtype=np.int64) - origem) / 1e6
        df = pd.DataFrame({"TimeUS": att["TimeUS"].to_numpy(), "t": t, "Roll": att["Roll"].to_numpy(),
                           "Pitch": att["Pitch"].to_numpy(), "Yaw": att["Yaw"].to_numpy()})
        if inicio_s is not None:
            df = df[(df["t"] >= inicio_s - 5) & (df["t"] <= (fim_s if fim_s is not None else np.inf) + 5)]
        return df.reset_index(drop=True), "gravada pelo ArduPilot (ATT)"
    return None, "log sem IMU/ATT"


def detectar_orientacao(dados, origem=None):
    """
    Descobre se a placa está montada com a seta para trás comparando a
    aceleração da corrida de decolagem medida pelo GPS com o eixo X do
    acelerômetro. Devolve dict com "orientacao" ("normal",
    "invertida_180" ou None se não deu para decidir) e a evidência.
    """
    imu, gps = dados.get("IMU"), dados.get("GPS")
    if imu is None or gps is None or not len(imu) or not len(gps):
        return {"orientacao": None, "motivo": "log sem IMU ou GPS"}
    if origem is None:
        origem = min(int(df["TimeUS"].min()) for df in dados.values() if "TimeUS" in df.columns and len(df))
    imu = utils.filtrar_instancia(imu, "I")
    gps = utils.filtrar_instancia(gps, "I")
    gps = gps[gps["Status"] >= 3]
    tg, ti = _segundos(gps, origem), _segundos(imu, origem)
    vel = gps["Spd"].to_numpy(dtype=np.float64)

    # Corrida de decolagem: primeiro trecho em que a velocidade sai de
    # parado (< 1 m/s) e passa de 5 m/s.
    acima = np.nonzero(vel > 5.0)[0]
    if not len(acima):
        return {"orientacao": None, "motivo": "o avião não passou de 5 m/s"}
    fim = acima[0]
    parados = np.nonzero(vel[:fim] < 1.0)[0]
    if not len(parados):
        return {"orientacao": None, "motivo": "sem trecho parado antes da decolagem"}
    ini = parados[-1]
    t0, t1 = tg[ini], tg[fim]
    if t1 - t0 < 0.5:
        return {"orientacao": None, "motivo": "corrida de decolagem curta demais"}
    acel_gps = (vel[fim] - vel[ini]) / (t1 - t0)

    acc_x = imu["AccX"].to_numpy(dtype=np.float64)
    antes = (ti > t0 - 10) & (ti < t0 - 1)
    durante = (ti >= t0) & (ti <= t1)
    if antes.sum() < 10 or durante.sum() < 10:
        return {"orientacao": None, "motivo": "poucas amostras de IMU na decolagem"}
    delta_x = float(acc_x[durante].mean() - acc_x[antes].mean())
    evidencia = {
        "inicio_corrida_s": round(float(t0), 1),
        "fim_corrida_s": round(float(t1), 1),
        "aceleracao_gps_ms2": round(float(acel_gps), 2),
        "variacao_acc_x_ms2": round(delta_x, 2),
    }
    if abs(delta_x) < 0.3 or acel_gps < 0.3:
        return {"orientacao": None, "motivo": "aceleração pequena demais para decidir", **evidencia}
    orientacao = "normal" if delta_x > 0 else "invertida_180"
    return {"orientacao": orientacao, "motivo": "eixo X do acelerômetro vs aceleração do GPS na decolagem",
            **evidencia}
