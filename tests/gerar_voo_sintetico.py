"""
gerar_voo_sintetico.py

Gera logs DataFlash (.bin) sintéticos de um avião ArduPlane para testar a
detecção de eventos: cada voo tem ~120 s (parado, corrida de decolagem,
subida, circuito com duas curvas, descida e fim) e pode trazer um defeito
conhecido (bateria fraca, vibração alta, perda de GPS, placa ao contrário,
impacto). Assim dá para conferir se o dossiê aponta o problema certo.

A trajetória é definida por perfis suaves (velocidade, altitude, taxa de
curva) e a IMU é calculada a partir dela: aceleração específica e rotação
no referencial da placa. Com a placa normal, AccX fica positivo na corrida
de decolagem e AccZ ≈ -9,8 m/s² parado, como numa controladora real.

Rode a partir da raiz do projeto:

    python tests/gerar_voo_sintetico.py --defeito limpo --saida voo.bin
    python tests/gerar_voo_sintetico.py --todos tests/voos_sinteticos

Defeitos: limpo, bateria_fraca, vibracao_alta, perda_gps, placa_invertida,
impacto.
"""

import argparse
import math
import struct
from pathlib import Path

import numpy as np

DEFEITOS = ("limpo", "bateria_fraca", "vibracao_alta", "perda_gps", "placa_invertida", "impacto")

# Formato DataFlash: caractere do FMT -> formato do struct e multiplicador.
STRUCT = {"a": "64s", "b": "b", "B": "B", "g": "e", "h": "h", "H": "H", "i": "i", "I": "I",
          "f": "f", "n": "4s", "N": "16s", "Z": "64s", "c": "h", "C": "H", "e": "i", "E": "I",
          "L": "i", "d": "d", "M": "b", "q": "q", "Q": "Q"}
MULT = {"c": 100, "C": 100, "e": 100, "E": 100, "L": 1e7}

# Mensagens gravadas (id, nome, formato, colunas) -- mesmas do ArduPlane.
FORMATOS = [
    (129, "MSG", "QZ", "TimeUS,Message"),
    (130, "PARM", "QNff", "TimeUS,Name,Value,Default"),
    (131, "MODE", "QMBB", "TimeUS,Mode,ModeNum,Rsn"),
    (132, "GPS", "QBBIHBcLLeffffB", "TimeUS,I,Status,GMS,GWk,NSats,HDop,Lat,Lng,Alt,Spd,GCrs,VZ,Yaw,U"),
    (133, "BAT", "QBfffffcfB", "TimeUS,Inst,Volt,VoltR,Curr,CurrTot,EnrgTot,Temp,Res,RemPct"),
    (134, "BARO", "QBfffcfIffB", "TimeUS,I,Alt,AltAMSL,Press,Temp,CRt,SMS,Offset,GndTemp,Health"),
    (135, "ARSP", "QBffcff", "TimeUS,I,Airspeed,DiffPress,Temp,RawPress,Offset"),
    (136, "VIBE", "QBfffI", "TimeUS,IMU,VibeX,VibeY,VibeZ,Clip"),
    (137, "ATT", "QccccCCCCB", "TimeUS,DesRoll,Roll,DesPitch,Pitch,DesYaw,Yaw,ErrRP,ErrYaw,AEKF"),
    (138, "IMU", "QBffffffIIfBBHH", "TimeUS,I,GyrX,GyrY,GyrZ,AccX,AccY,AccZ,EG,EA,T,GH,AH,GHz,AHz"),
]

G = 9.81
HZ = 200                          # passo da simulação (Hz)
DURACAO_S = 120.0
T0_US = 3_000_000                 # primeira mensagem 3 s após o boot
LAT0, LNG0 = -23.4050, -51.9380   # campo perto de Maringá
ALT_SOLO_M = 550.0
M_LAT = 1 / 111_320
M_LNG = 1 / (111_320 * math.cos(math.radians(LAT0)))
CELULAS = 4

# Instantes do roteiro (s desde a primeira mensagem)
T_ACELERA = 20.0      # motor em potência, começa a corrida
T_SAIDA_SOLO = 24.5   # sai do chão
T_DESCIDA = 74.0      # começa a descida para o pouso
T_TOQUE = 90.0        # toca a pista (voo normal)
T_IMPACTO = 82.0      # defeito "impacto": bate no chão
T_SEM_GPS = (55.0, 63.0)  # defeito "perda_gps"


class EscritorBin:
    """Monta o .bin em memória: FMT de cada mensagem e depois as linhas."""

    def __init__(self):
        self.saida = bytearray()
        self.formatos = {}
        for tid, nome, formato, colunas in FORMATOS:
            st = "<" + "".join(STRUCT[c] for c in formato)
            tamanho = struct.calcsize(st) + 3
            self.formatos[nome] = (tid, formato, st)
            self.saida.extend(b"\xa3\x95\x80" + struct.pack("<BB4s16s64s", tid, tamanho, nome.encode(),
                                                             formato.encode(), colunas.encode()))

    def msg(self, nome, *valores):
        tid, formato, st = self.formatos[nome]
        convertidos = []
        for c, v in zip(formato, valores):
            if c in MULT:
                v = int(round(v * MULT[c]))
            elif c in "nNZ":
                v = v.encode()
            elif c in "bBhHiIMqQ":
                v = int(v)
            convertidos.append(v)
        self.saida.extend(b"\xa3\x95" + bytes([tid]) + struct.pack(st, *convertidos))


# -----------------------------------------------------------------------
# Trajetória
# -----------------------------------------------------------------------
def _perfil(t, pontos, suavizar_s=0.6):
    """Perfil linear por trechos (lista de (t, valor)) suavizado por média móvel."""
    tp, vp = zip(*pontos)
    bruto = np.interp(t, tp, vp)
    n = max(1, int(suavizar_s * HZ))
    janela = np.ones(n) / n
    preenchido = np.concatenate([np.full(n, bruto[0]), bruto, np.full(n, bruto[-1])])
    return np.convolve(preenchido, janela, mode="same")[n:-n]


def trajetoria(defeito):
    """
    Estado do avião a cada passo: posição NED (m), velocidade, rumo, atitude
    (graus) e aceleração específica / velocidades angulares no referencial
    do avião (eixo X para a frente, Z para baixo).
    """
    t = np.arange(int(DURACAO_S * HZ) + 1) / HZ
    impacto = defeito == "impacto"

    if impacto:
        # Mergulho raso a 18 m/s até o chão e parada em ~0,5 s.
        vel = _perfil(t, [(0, 0), (T_ACELERA, 0), (T_ACELERA + 5, 16), (T_ACELERA + 8, 18),
                          (T_IMPACTO, 18), (T_IMPACTO + 0.5, 0), (DURACAO_S, 0)], 0.15)
        alt = _perfil(t, [(0, 0), (T_SAIDA_SOLO, 0), (T_SAIDA_SOLO + 13.3, 40), (T_DESCIDA - 2, 40),
                          (T_IMPACTO, 0), (DURACAO_S, 0)], 0.15)
    else:
        # Pouso suave: aproxima a 14 m/s, toca a 13 m/s e freia a ~1,5 m/s².
        vel = _perfil(t, [(0, 0), (T_ACELERA, 0), (T_ACELERA + 5, 16), (T_ACELERA + 8, 18),
                          (T_DESCIDA, 18), (T_DESCIDA + 6, 14), (T_TOQUE, 13),
                          (T_TOQUE + 13 / 1.5, 0), (DURACAO_S, 0)])
        alt = _perfil(t, [(0, 0), (T_SAIDA_SOLO, 0), (T_SAIDA_SOLO + 13.3, 40), (T_DESCIDA, 40),
                          (T_TOQUE, 0), (DURACAO_S, 0)])
    vel = np.maximum(vel, 0.0)
    alt = np.maximum(alt, 0.0)

    # Duas curvas de 180° para a esquerda a 0,3 rad/s (circuito retangular).
    taxa = 0.3
    duracao_curva = math.pi / taxa
    curvas = [(40.0, 40.0 + duracao_curva), (56.0, 56.0 + duracao_curva)]
    pontos = [(0, 0)]
    for ini, fim in curvas:
        pontos += [(ini, 0), (ini + 0.01, -taxa), (fim - 0.01, -taxa), (fim, 0)]
    pontos.append((DURACAO_S, 0))
    psi_ponto = _perfil(t, pontos, 0.8)
    psi = math.radians(90.0) + np.cumsum(psi_ponto) / HZ   # começa apontando para leste

    # Posição (NED) integrando a velocidade.
    vn, ve = vel * np.cos(psi), vel * np.sin(psi)
    norte = np.cumsum(vn) / HZ
    leste = np.cumsum(ve) / HZ
    vd = -np.gradient(alt, 1 / HZ)
    an, ae, ad = (np.gradient(v, 1 / HZ) for v in (vn, ve, vd))

    # Atitude: curva coordenada (roll = atan(v·ψ'/g)); pitch = trajetória + ângulo de ataque.
    no_ar = np.clip(alt / 2.0, 0, 1)
    roll = np.arctan(vel * psi_ponto / G) * no_ar
    gama = np.arctan2(-vd, np.maximum(vel, 0.5))
    pitch = gama + math.radians(4.0) * no_ar
    if impacto:
        # Depois da batida fica de nariz no chão.
        depois = t > T_IMPACTO + 0.3
        pitch = np.where(depois, math.radians(-35.0), pitch)
        roll = np.where(depois, math.radians(20.0), roll)
        pitch = _perfil(t, list(zip(t, pitch)), 0.15)
        roll = _perfil(t, list(zip(t, roll)), 0.15)

    # Aceleração específica = aceleração - gravidade (NED), girada para o avião.
    fn, fe, fd = an, ae, ad - G
    cf, sf = np.cos(roll), np.sin(roll)
    ct, st = np.cos(pitch), np.sin(pitch)
    cp, sp = np.cos(psi), np.sin(psi)
    # Linhas da matriz NED -> corpo (sequência 3-2-1).
    ax = ct * cp * fn + ct * sp * fe - st * fd
    ay = (sf * st * cp - cf * sp) * fn + (sf * st * sp + cf * cp) * fe + sf * ct * fd
    az = (cf * st * cp + sf * sp) * fn + (cf * st * sp - sf * cp) * fe + cf * ct * fd

    # Velocidades angulares no corpo a partir das derivadas dos ângulos de Euler.
    roll_p, pitch_p, psi_p = (np.gradient(a, 1 / HZ) for a in (roll, pitch, psi))
    gx = roll_p - psi_p * st
    gy = pitch_p * cf + psi_p * sf * ct
    gz = -pitch_p * sf + psi_p * cf * ct

    return {
        "t": t, "vel": vel, "alt": alt, "vd": vd, "norte": norte, "leste": leste,
        "rumo": np.degrees(psi) % 360, "roll": np.degrees(roll), "pitch": np.degrees(pitch),
        "acc": np.vstack([ax, ay, az]), "gir": np.vstack([gx, gy, gz]),
    }


# -----------------------------------------------------------------------
# Sensores
# -----------------------------------------------------------------------
def _corrente(t, tr, defeito):
    """Corrente do motor (A) pela fase do voo."""
    if t < T_ACELERA:
        return 1.0
    if defeito == "impacto" and t >= T_IMPACTO:
        # Hélice bate no chão: pico e depois motor parado.
        return 65.0 if t < T_IMPACTO + 0.6 else 0.5
    if t < T_SAIDA_SOLO + 13.3:
        return 24.0                    # corrida e subida
    if t < T_DESCIDA:
        return 15.0                    # cruzeiro
    if t < T_TOQUE:
        return 6.0                     # descida
    return 1.0


def _tensao(t, corrente, consumo_mah, defeito):
    """Tensão do pack 4S: tensão em repouso pela carga gasta menos a queda na resistência interna."""
    if defeito == "bateria_fraca":
        # Pack cansado: a tensão de repouso desaba no fim e a resistência é alta.
        repouso = 16.5 - 0.4 * consumo_mah / 300 - (3.4 * min(1.0, max(0.0, (t - 60) / 20)) if t > 60 else 0)
        return repouso - 0.045 * corrente
    repouso = 16.75 - 0.6 * consumo_mah / 600
    return repouso - 0.02 * corrente


def gerar(defeito, caminho, semente=7):
    """Escreve o voo sintético com o defeito pedido em `caminho` (.bin)."""
    if defeito not in DEFEITOS:
        raise ValueError(f"Defeito desconhecido: {defeito}. Use um de {list(DEFEITOS)}.")
    rng = np.random.default_rng(semente)
    tr = trajetoria(defeito)
    t = tr["t"]
    log = EscritorBin()

    invertida = defeito == "placa_invertida"
    vibracao = defeito == "vibracao_alta"

    msg = log.msg
    msg("MSG", T0_US, "ArduPlane V4.5.7 (abcdef12)")
    msg("MSG", T0_US + 5, "MatekH743 003A0030 3231510A 34393735")
    msg("MSG", T0_US + 10, "ChibiOS: 6a85082c")
    parametros = {"AHRS_ORIENTATION": 0.0, "AHRS_EKF_TYPE": 3.0, "BATT_MONITOR": 4.0, "BATT_CAPACITY": 2200.0,
                  "ARSPD_TYPE": 0.0, "ARSPD_USE": 0.0, "THR_FAILSAFE": 1.0, "LOG_BITMASK": 65535.0}
    for i, (nome, valor) in enumerate(parametros.items()):
        msg("PARM", T0_US + 20 + i, nome, valor, 0.0)
    msg("MODE", T0_US + 100, 0, 0, 0)                     # MANUAL
    modos = [(T_ACELERA - 1, 13), (T_SAIDA_SOLO + 14, 10)]  # TAKEOFF, AUTO

    consumo_mah = energia_wh = 0.0
    clip = 0
    for k, tk in enumerate(t):
        us = T0_US + int(round(tk * 1e6))
        vel, alt, rumo = tr["vel"][k], tr["alt"][k], tr["rumo"][k]
        roll, pitch = tr["roll"][k], tr["pitch"][k]
        lat = LAT0 + tr["norte"][k] * M_LAT
        lng = LNG0 + tr["leste"][k] * M_LNG
        em_voo = vel > 3.0

        # IMU a 100 Hz
        if k % 2 == 0:
            acc = tr["acc"][:, k].copy()
            gir = tr["gir"][:, k].copy()
            ruido_acc = 6.0 if (vibracao and em_voo) else (0.6 if tk >= T_ACELERA else 0.05)
            acc += rng.normal(0, ruido_acc, 3)
            gir += rng.normal(0, 0.01, 3)
            if defeito == "impacto" and T_IMPACTO - 0.05 <= tk <= T_IMPACTO + 0.4:
                acc += np.array([-12 * G, 3 * G, -6 * G]) * math.exp(-(tk - T_IMPACTO) / 0.1)
            if invertida:
                # Placa girada 180° em torno de Z: X e Y trocam de sinal.
                acc[:2] *= -1
                gir[:2] *= -1
            msg("IMU", us, 0, *gir, *acc, 0, 0, 35.0, 1, 1, 1000, 1000)

        # Atitude a 25 Hz. Com a placa girada e AHRS_ORIENTATION=0, o
        # ArduPilot vê roll e pitch com o sinal trocado.
        if k % 8 == 0:
            sinal = -1 if invertida else 1
            r_reg, p_reg = sinal * roll, sinal * pitch
            des_r = r_reg + rng.normal(0, 0.8)
            des_p = p_reg + rng.normal(0, 0.8)
            yaw_reg = (rumo + (180 if invertida else 0)) % 360
            msg("ATT", us, des_r, r_reg, des_p, p_reg, yaw_reg, yaw_reg, 0.05, 0.1, 3)

        # Barômetro a 20 Hz (duas instâncias)
        if k % 10 == 0:
            baro = alt + rng.normal(0, 0.15)
            msg("BARO", us, 0, baro, ALT_SOLO_M + baro, 95000.0 - 11.5 * alt, 25.0, -tr["vd"][k], us // 1000, 0.0, 25.0, 1)
            msg("BARO", us + 1, 1, baro + 0.3, ALT_SOLO_M + baro + 0.3, 94996.0 - 11.5 * alt, 25.5,
                -tr["vd"][k], us // 1000, 0.0, 25.0, 1)

        # Bateria, Pitot e vibração a 10 Hz
        if k % 20 == 0:
            corrente = _corrente(tk, tr, defeito) + rng.normal(0, 0.3)
            corrente = max(0.0, corrente)
            consumo_mah += corrente * 0.1 / 3.6
            volt = _tensao(tk, corrente, consumo_mah, defeito) + rng.normal(0, 0.02)
            energia_wh += volt * corrente * 0.1 / 3600
            restante = max(0, int(100 - 100 * consumo_mah / 2200))
            msg("BAT", us, 0, volt, volt + 0.02 * corrente, corrente, consumo_mah, energia_wh, 30.0, 0.02, restante)
            msg("BAT", us + 1, 1, 5.1, 5.1, 0.5, 1.0, 0.0, 30.0, 0.0, 100)
            arsp = vel + rng.normal(0, 0.3) if vel > 1 else abs(rng.normal(0, 0.3))
            msg("ARSP", us, 0, arsp, 0.613 * arsp ** 2, 25.0, 1000.0, 0.5)

            if vibracao and em_voo:
                vx, vy, vz = rng.uniform(40, 55), rng.uniform(40, 55), rng.uniform(50, 70)
                if rng.random() < 0.08:
                    clip += 1                       # acelerômetro saturando ao longo do voo
            else:
                base = 3.0 + 0.4 * vel
                vx, vy, vz = base + rng.uniform(0, 1), base + rng.uniform(0, 1), 2 * base + rng.uniform(0, 2)
            if defeito == "impacto" and T_IMPACTO <= tk <= T_IMPACTO + 0.5:
                vx, vy, vz = 90.0, 70.0, 120.0
                clip += 5
            msg("VIBE", us, 0, vx, vy, vz, clip)
            msg("VIBE", us + 1, 1, vx * 0.8, vy * 0.8, vz * 0.8, 0)

        # GPS a 5 Hz
        if k % 40 == 0:
            status, sats, hdop = (1, 0, 99.99) if tk < 5 else (3, 14, 0.7)
            if defeito == "perda_gps":
                ini, fim = T_SEM_GPS
                if ini - 2 <= tk < ini:
                    sats, hdop = 5, 3.5                 # degradando antes de perder
                elif ini <= tk < fim:
                    status, sats, hdop = 1, 3, 9.5
                elif fim <= tk < fim + 2:
                    sats, hdop = 5, 2.8                 # recuperando
            ruido = rng.normal(0, 0.3, 2) if status >= 3 else (0, 0)
            msg("GPS", us, 0, status, int(tk * 1000) % 604_800_000, 2330, sats, hdop,
                lat + ruido[0] * M_LAT, lng + ruido[1] * M_LNG, ALT_SOLO_M + alt + rng.normal(0, 0.3),
                vel, rumo, tr["vd"][k], 0.0, 1)

        for instante, numero in modos:
            if abs(tk - instante) < 0.5 / HZ:
                msg("MODE", us, numero, numero, 1)

    caminho = Path(caminho)
    caminho.parent.mkdir(parents=True, exist_ok=True)
    caminho.write_bytes(log.saida)
    return caminho


def main():
    argumentos = argparse.ArgumentParser(description="Gera voos sintéticos (.bin) com defeitos conhecidos.")
    argumentos.add_argument("--defeito", choices=DEFEITOS, help="defeito a simular")
    argumentos.add_argument("--saida", help="arquivo .bin de saída")
    argumentos.add_argument("--todos", metavar="PASTA", help="gera um .bin de cada defeito nesta pasta")
    a = argumentos.parse_args()

    if a.todos:
        for defeito in DEFEITOS:
            caminho = gerar(defeito, Path(a.todos) / f"{defeito}.bin")
            print(f"{caminho}: {caminho.stat().st_size / 1e6:.1f} MB")
    elif a.defeito and a.saida:
        caminho = gerar(a.defeito, a.saida)
        print(f"{caminho}: {caminho.stat().st_size / 1e6:.1f} MB")
    else:
        argumentos.error("use --defeito <nome> --saida <arquivo.bin> ou --todos <pasta>")


if __name__ == "__main__":
    main()
