# ADAM Flight Analysis

Ferramenta em Python para analisar logs de voo **DataFlash (`.bin`) do ArduPilot**.
Ela lê o log, separa as mensagens por tipo (GPS, BAT, BARO, VIBE…) e calcula
métricas de bateria, trajetória, altitude e vibração. Os resultados saem no
terminal, em CSV, em um relatório PDF ou em um dashboard web (Streamlit) com
abas. Um **agente analista de voo** (Claude Code) interpreta os logs e aponta
problemas de segurança, sempre com evidência do próprio log.

## Estrutura

```
adam-flight-analysis/
├── aeronave.toml          # ficha do avião (massa, asa, bateria, propulsão) para as análises
├── config.py              # caminhos de pastas e constantes (único lugar com caminhos)
├── parser.py              # lê o .bin -> dict de DataFrames (um por tipo de mensagem), com cache
├── utils.py               # funções comuns: tempo, altitude relativa, integração, haversine, filtro de instância
├── exportar_csv.py        # exporta mensagens brutas e o histórico de resumos em CSV
├── diag_voo               # script de diagnóstico das mensagens VIBE de um log
├── .claude/agents/
│   └── analista-voo.md    # agente analista de voo (Claude Code)
├── analysis/
│   ├── battery.py             # tensão, corrente, potência, consumo (mAh / Wh)  <- BAT
│   ├── gps.py                 # distância, velocidade, HDop, satélites, % de fix  <- GPS
│   ├── flight_performance.py  # altitude máxima, taxa de subida/descida            <- BARO (ou GPS)
│   ├── imu_vibration.py       # vibração X/Y/Z e clipping                         <- VIBE
│   ├── statistics.py          # roda todas as análises e monta o resumo do voo
│   ├── ficha.py               # lê a ficha da aeronave (aeronave.toml)
│   ├── atitude.py             # recalcula roll/pitch/rumo da IMU (placa invertida/sem calibração)
│   ├── eventos.py             # detecta eventos de segurança (limites em um só lugar: LIMITES)
│   ├── dossie.py              # gera o dossiê do voo (JSON) lido pelo analista
│   ├── consulta.py            # consulta valores do log num trecho de tempo (terminal)
│   ├── espectro.py            # espectro de vibração, espectrograma e batch sampler
│   └── aerodinamica.py        # vento estimado, CL em voo, fator de carga, Reynolds, estol
├── report/
│   └── pdf_report.py      # gera o relatório PDF com métricas e gráficos
├── visualization/
│   ├── dashboard.py       # dashboard Streamlit: barra lateral (arquivo e trecho) + navegação das abas
│   ├── abas/              # uma aba por arquivo: voo, explorador, aerodinamica, replay, saude, vibracao
│   ├── dados_voo.py       # recorta o trecho, reduz pontos e monta os dados dos painéis
│   ├── painel_voo.py      # componente Streamlit do painel interativo (mapa + gráficos + tempo)
│   ├── painel_voo_web/    # painel em HTML/JS: mapa (Leaflet) + gráficos (Plotly) + barra de tempo
│   │   └── vendor/        # bibliotecas JS servidas localmente (plotly.min.js é copiado sozinho)
│   ├── replay_voo.py      # componente Streamlit do replay 3D
│   ├── replay_voo_web/    # replay 3D em HTML/JS (three.js em vendor/)
│   ├── historico.py       # página Streamlit: todos os voos e a evolução de uma métrica
│   ├── comparacao.py      # página Streamlit: compara 2 ou mais voos
│   └── plots.py           # gráficos Plotly avulsos (não são mais usados pelo dashboard)
└── data/
    ├── logs/              # coloque aqui os arquivos .bin
    ├── csv/               # CSVs exportados (por voo + historico_voos.csv)
    └── cache/             # cache do parsing e imagens temporárias do PDF
```

## Instalação

Requer Python 3.11 ou mais recente (a ficha da aeronave usa `tomllib`).

```powershell
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
```

> A pasta `venv/` não deve ser copiada entre computadores: ela guarda o caminho
> absoluto do Python de quem a criou. Em cada máquina, apague-a e crie de novo
> com os comandos acima.

## Uso

Coloque um ou mais arquivos `.bin` em `data/logs/` e rode os comandos **a partir
da raiz do projeto**:

| Comando | O que faz |
|---|---|
| `python parser.py` | Lista os tipos de mensagem do primeiro `.bin` e mostra as primeiras linhas de GPS |
| `python -m analysis.statistics` | Imprime o resumo completo de cada voo |
| `python -m analysis.battery` | Só a análise de bateria (primeiro `.bin`) |
| `python -m analysis.gps` | Só a análise de GPS |
| `python -m analysis.flight_performance` | Só altitude / taxa vertical |
| `python -m analysis.imu_vibration` | Só vibração |
| `python exportar_csv.py` | Exporta as mensagens brutas de cada voo e atualiza `data/csv/historico_voos.csv` |
| `python report/pdf_report.py` | Gera `relatorio_teste.pdf` a partir do primeiro `.bin` |
| `python diag_voo` | Mostra colunas e estatísticas de VIBE por IMU |
| `python -m analysis.dossie "data/logs/voo.bin"` | Dossiê de segurança do voo: eventos, o que não é confiável, métricas (grava JSON em `data/cache/dossies/`) |
| `python -m analysis.consulta "data/logs/voo.bin" --tipo BAT --campos Volt,Curr --inicio 600 --fim 650 --passo 1` | Valores do log num trecho (`--listar` mostra os tipos; `--tipo ATITUDE` = atitude recalculada) |
| `streamlit run visualization/dashboard.py` | Abre o dashboard de voo no navegador (veja abaixo) |
| `streamlit run visualization/historico.py` | Abre o histórico de todos os voos* |
| `streamlit run visualization/comparacao.py` | Abre a comparação entre voos* |

\* As páginas de histórico e de comparação leem `data/csv/historico_voos.csv`.
Rode `python exportar_csv.py` antes de abri-las e de novo sempre que adicionar
voos novos.

Os módulos de `analysis/` precisam ser executados com `python -m`. Rodar
`python analysis/gps.py` direto falha, porque a raiz do projeto não entra no
caminho de importação.

### Uso em código

```python
import parser
from analysis import statistics

dados = parser.ler_log("data/logs/voo01.bin")   # usa o cache se existir
resumo = statistics.resumir_voo("data/logs/voo01.bin", dados=dados)
statistics.imprimir_resumo(resumo)
```

Se você já tem `dados`, passe-os para `resumir_voo` e `exportar_resumo_csv`. Assim
o `.bin` não é lido de novo.

## Dashboard de voo

```powershell
streamlit run visualization/dashboard.py
```

O arquivo e o **trecho de tempo** escolhidos na barra lateral valem para todas
as abas. Só a aba aberta é calculada, e o log completo (todas as mensagens) só
é carregado quando uma aba precisa dele.

| Aba | O que mostra |
|---|---|
| **Voo** | Métricas do trecho, mapa, velocidade/altitude/bateria sincronizados (descrito abaixo) |
| **Explorador** | **Qualquer campo de qualquer mensagem** (~50 tipos) em gráficos sincronizados com o mapa e a barra de tempo; unidades lidas do próprio log; tabela do trecho com download em CSV; busca nos parâmetros (PARM) e nas mensagens de texto |
| **Aerodinâmica** | Densidade do ar, carga alar, **vento estimado pelo GPS** (sem Pitot), velocidade do ar estimada, **CL em voo**, fator de carga, ângulo de ataque estimado, Reynolds, curva CL × α, potência × velocidade e tabela de velocidades de estol por CLmax. Massa/área/envergadura vêm da ficha e podem ser alteradas na tela |
| **Replay 3D** | O voo em 3D: modelo do avião (dimensões da ficha) com a atitude de cada instante, trajeto colorido por velocidade, câmeras de perseguição/livre/visão geral, exagero vertical e os **eventos detectados marcados na barra de tempo** |
| **Saúde do sistema** | Quadro "semáforo" (EKF, processador, gravação do log, GPS, alimentação, IMU, barômetro, bússola) e gráficos de cada componente |
| **Vibração** | Níveis com os limites do ArduPilot (30/60 m/s²), clipping, vibração por fase (motor parado / ligado / em voo), espectro de frequências e espectrograma; usa o **batch sampler** (alta taxa) automaticamente se o log tiver |

Observações sobre as estimativas:
- **Atitude recalculada:** se a controladora estiver montada ao contrário
  (detectado pela física: na decolagem o acelerômetro X aponta para trás) ou a
  ficha disser que não está calibrada, a atitude é **recalculada da IMU** com a
  orientação corrigida. No primeiro voo real, o roll recalculado bateu com a
  inclinação esperada pelas curvas do GPS (correlação 0,86), enquanto o gravado
  estava com o sinal trocado.
- **Vento e CL sem Pitot:** o vento só é considerado confiável com quase uma
  volta completa no trecho (≥ 270° de rumo) e velocidade do ar quase constante;
  senão, a correção fica desligada e as velocidades usam o GPS.
- **Vibração:** a mensagem IMU normal é gravada devagar e só mostra
  frequências baixas. Para ver motor e hélice, ligue o batch sampler
  (`INS_LOG_BAT_MASK = 1`) antes do voo.

### Aba Voo

- **Barra lateral:** escolha o arquivo `.bin` e o **trecho de tempo** a analisar e
  clique em *Aplicar trecho*. Só esse pedaço é processado. Ao abrir um log, o
  trecho inicial é o **voo detectado automaticamente** (quando a aeronave passa
  de 3 m/s), sem o tempo parado no solo. Os botões *Log inteiro* e *Só o voo*
  trocam o trecho rapidamente.
- **Métricas do trecho:** duração, distância, altitude, velocidades máximas,
  consumo, energia, tensão mínima, corrente e potência máximas.
- **Barra de tempo:** ▶/⏸ reproduz o voo, com velocidade de 0,25× a 30×, e os
  botões ⏮, −10 s e +10 s navegam. A barra pode ser arrastada. Teclado: espaço,
  ← → (1 s), Shift + ← → (10 s), Home.
- **Valores instantâneos:** velocidade solo (GPS), velocidade do ar (se houver
  tubo de Pitot), altitude, tensão, corrente, potência, consumo acumulado e modo
  de voo no instante do cursor.
- **Gráficos sincronizados:** velocidade, altitude, tensão, corrente e potência
  compartilham o eixo do tempo. Passar o mouse move o cursor em todos e no
  mapa. Arrastar dá zoom nos cinco ao mesmo tempo, e as faixas coloridas mostram
  o modo de voo. *Analisar trecho do zoom* recalcula as métricas só para o
  trecho visível.
- **Mapa:** trajeto colorido por velocidade, altitude ou potência, sobre
  satélite, ruas ou relevo. O avião acompanha o cursor, apontando o rumo.
  Passar o mouse no trajeto leva os gráficos para aquele instante. *Seguir
  aeronave* centraliza o mapa durante a reprodução. *Abrir posição no Google
  Maps* abre o ponto atual no Google Maps, e *Baixar trajeto (KML)* exporta o
  trecho para o Google Earth ou o Google My Maps.

**Por que continua fluido:** o Streamlit roda o script Python inteiro a cada
interação, o que travaria um cursor sincronizado. Por isso o painel (mapa,
gráficos, barra de tempo) é um componente que roda **todo no navegador**. Mover
o mouse, reproduzir ou dar zoom não executa Python, e os gráficos não são
redesenhados: só a linha do cursor se move. O Python só roda ao trocar de
arquivo ou de trecho, e o resultado de cada trecho fica em cache. Para manter o
navegador leve, cada série é reduzida a no máximo ~4000 pontos, preservando o
mínimo e o máximo de cada bloco. Assim um pico de corrente de uma única amostra
continua visível.

As bibliotecas do painel são servidas localmente, então ele funciona sem
internet, exceto as imagens de fundo do mapa.

## Analista de voo (agente do Claude Code)

O arquivo `.claude/agents/analista-voo.md` define um **analista de segurança de
voo**. No Claude Code, peça por exemplo *"analise o voo data/logs/X.bin"* ou
*"o que aconteceu aos 10:37?"*. Ele:

1. gera o **dossiê** (`python -m analysis.dossie`): eventos detectados por
   regras (`analysis/eventos.py`), o que **não** é confiável no log, métricas e
   parâmetros importantes;
2. confere as evidências com `python -m analysis.consulta`;
3. escreve um parecer: veredito, linha do tempo, achados (gravidade +
   confiança + evidência), o que o log não permite afirmar e recomendações.

Regra central: **quem calcula é o código; o agente interpreta**. Todo número
citado vem das ferramentas, com o instante do log. A ficha (`aeronave.toml`) diz
como a controladora está instalada. Com `funcao = "registrador"` (receptor
direto nos servos), modos e failsafes do log não são tratados como causa de
nada.

Os voos sintéticos com defeitos injetados (`tests/gerar_voo_sintetico.py`)
servem de "exame" para o analista e os detectores: bateria fraca, vibração
alta, perda de GPS, placa invertida, impacto e um voo limpo, que serve para
checar que nenhum problema é inventado. No primeiro exame, o analista tirou
nota 8 a 9 em todos e encontrou o defeito em todos os voos.

### Como fazer uma pergunta ao analista

1. Recrie a venv (veja *Instalação*). O analista roda os scripts do projeto com ela.
2. Coloque o `.bin` em `data/logs/` e confira se `aeronave.toml` está atualizado.
3. Abra o Claude Code (terminal ou extensão do VS Code) **na raiz do projeto**.
   O agente só é encontrado a partir dessa pasta. Para conferir, digite `/agents`.
4. Escreva a pergunta no chat, começando com `analista-voo:`. Exemplos:
   - `analista-voo: analise o voo data/logs/2026-09-30 16-35-24.bin`
   - `analista-voo: o que aconteceu aos 10:37 nesse log?`
   - `analista-voo: por que o avião caiu? Se não houver dados suficientes, diga o que seria necessário.`
   - `analista-voo: a bateria aguentou bem nesse voo?`
5. A análise leva cerca de 2 minutos. Depois você pode continuar a conversa
   ("e 5 s antes do impacto?") e passar informações que o log não tem, como o
   relato do piloto, a hélice usada ou o vento. O analista refaz o
   diagnóstico com elas.

O tempo citado pelo analista conta desde a primeira mensagem do log
(640 s = 10:40). O agente só lê arquivos e não altera nada no projeto.

## Voos analisados

### 2026-09-30 16-35-24.bin — primeiro voo real (queda)

ArduPlane 4.7, SpeedyBee F405 Wing. A controladora só registra: o receptor
vai direto nos servos e no ESC. Ela estava montada ao contrário e sem
calibração, e não havia tubo de Pitot.

**O que o log mostra (medido):**
- Decolagem por volta de 10:14 e curva contínua à esquerda subindo até ~23 m
  acima da decolagem (pelo GPS; o barômetro estava contaminado pelo fluxo de ar).
- 10:36: o nariz baixa de repente (−59°/s) e a carga cai para 0,21 g.
- 10:37–10:40: mergulho de 3,4 s. A trajetória vai de −2,5° a −17° e a
  velocidade no solo sobe de 17,6 para 21 m/s. A carga fica em média em
  0,84 g e não passa de 1,10 g (média em 0,5 s; pico instantâneo de 1,40 g na
  IMU a 50 Hz). A rotação média do nariz é 0°/s, ou seja, não houve
  arredondamento. O motor ficou ligado (~33 A) até o fim.
- 10:40.3: impacto.
- Descartado: falha de motor ou de bateria. A tensão ficou em 3,82 V/célula,
  a resistência interna em 0,038 Ω e o consumo foi de 307 de 3300 mAh.

**Hipóteses da causa**, nenhuma confirmada só pelo log:
1. Estol em curva, possivelmente com vento de cauda.
2. Comando do piloto.
3. Profundor sem efeito: servo, ligação, alimentação ou failsafe do rádio.

**Informações do piloto (02/10):**
- A hélice usada foi **18x8**, não a 20x8 prevista.
- O piloto tentou recuperar velocidade, mas não tinha altura suficiente.
- Durante o mergulho ele **manteve o profundor para cima o tempo todo**.

**Reanálise com essas informações (03/10).** Contas com m = 5 kg,
S = 1,118 m² e ρ = 1,05 kg/m³:
- **O relato não combina com o que foi medido.** Com o profundor para cima e
  funcionando, a carga deveria crescer junto com a velocidade. Aconteceu o
  contrário: o CL implícito caiu de ~0,6 para ~0,35 durante o mergulho.
- **Estol durante o mergulho é pouco provável.** Para a asa estar estolada
  com a carga medida (CLmax 1,2–1,5), a velocidade no ar teria que ser de
  7,5–9 m/s. Isso exige 9–14 m/s de vento de cauda, e o vento estimado é de
  ~3–7 m/s. O início, às 10:36, ainda pode ter sido um estol em curva: a
  margem estimada era de ~2,4 m/s, menor que o erro da estimativa.
- **"Faltou altura" não explica a queda.** Um puxão de ~2 g arredondaria o
  mergulho perdendo só 1–2 m, e ainda havia ~11 m de altura.
- **Vento:** ~6–7 m/s de NNE (26–38°), estimado sem confiança porque só houve
  120–210° de curva. Se estiver certo, a curva de 300° para 235° era uma
  curva para o vento de cauda.
- **Hélice 18x8:** a corrente ficou em 36–38 A quase o voo todo (manete
  provavelmente no máximo). Só ~11% da potência elétrica virava subida, ou
  seja, havia pouca sobra de potência. A área do disco é 19% menor que a da
  20x8. Sem KV, RPM e teste de tração não dá para dizer quanto a 20x8 teria
  mudado.

**Diagnóstico mais compatível (confiança média).** Às 10:36 o nariz baixou,
por comando para ganhar velocidade ou por início de perda de sustentação na
curva. Depois disso o profundor **não produziu nariz para cima** durante
3,4 s. O log não separa as duas variantes:
- **(A) falha do profundor:** servo, ligação, alimentação, ou failsafe do rádio
  que manteve as posições;
- **(B) comando real diferente do que o piloto lembra:** deflexão pequena ou
  tardia, comum sob estresse.

O log do rádio e a inspeção do servo decidem entre A e B.

**Recomendações antes do próximo voo:**
- Inspecionar todo o comando do profundor e a alimentação do receptor/BEC.
  Teste em bancada: profundor todo para cima com o motor no máximo, conferindo
  a deflexão sob carga.
- Configurar e testar o failsafe do receptor, com o motor em baixo.
- `AHRS_ORIENTATION = 4` (Yaw180) e calibrar acelerômetro, nível e bússola.
- Voltar à hélice 20x8.
- Até haver Pitot, subir menos íngreme e fazer as curvas com mais altura,
  principalmente ao virar para o vento de cauda. Não trocar altura por
  velocidade abaixo de ~30 m.
- No início de cada voo, fazer uma volta completa (360°) com altura e manete
  constantes, para o vento poder ser estimado.

**O que falta para fechar a causa**, em ordem de prioridade:
1. Log do rádio (cartão SD do transmissor EdgeTX/OpenTX): sticks e qualidade
   do link.
2. Vídeo do voo.
3. Inspeção do servo e da ligação do profundor nos destroços.
4. Nos próximos voos:
   - gravar os comandos do piloto (saída SBUS/CRSF do receptor na entrada RX
     da controladora);
   - medir a tensão dos servos (`POWR.VServo`);
   - instalar um tubo de Pitot;
   - proteger o barômetro com espuma.

## Próximos passos

- Abas do dashboard ainda não feitas: **Eventos/analista** (linha do tempo
  dos eventos do dossiê), **Energia** (bateria e propulsão) e **Pré-voo**
  (checklist a partir dos parâmetros).
- Analista, próximas fases:
  - modelos de vento e de bateria;
  - simulações "e se" (ex.: outra hélice, mais altura, outro vento);
  - comparação entre voos.
- Ficha da aeronave (`aeronave.toml`):
  - ainda faltam motor (KV), hélice e corrente máxima;
  - falta confirmar a bateria 6S / 3300 mAh (deduzida do log).
- Detectores com ajuste conhecido (encontrados pelo analista no voo de 30/09):
  - o evento "pitch extremo" deve ignorar o que vem depois do impacto;
  - a altitude máxima do resumo deve usar o GPS quando o barômetro estiver
    marcado como contaminado;
  - `estimar_vento` dá resultados contraditórios com pouca curva (2–10 m/s
    conforme a janela). Falta uma opção com correção por energia
    (V²/2 + g·h), que foi a mais consistente neste voo.

## Detalhes importantes

- **Cache do parsing:** `parser.ler_log` grava o resultado em `data/cache/`, num
  arquivo `.pkl` cujo nome inclui o tamanho e a data de modificação do `.bin`.
  Se o `.bin` mudar, o cache antigo é ignorado. Use `ler_log(caminho, usar_cache=False)`
  para forçar uma nova leitura. Os `.pkl` antigos podem ser apagados à vontade.
- **Logs suportados:** firmware ArduPilot 3.3 ou mais recente (mensagens com
  `TimeUS`). Logs muito antigos, só com `TimeMS`, não são suportados.
- **Sensores redundantes:** quando há mais de um GPS, barômetro, bateria ou IMU,
  as linhas de cada sensor vêm intercaladas no log. As análises usam só a
  **instância 0** (colunas `I`, `Inst` ou `IMU`). Para escolher outra, use o
  parâmetro `instancia` / `instancia_imu` das funções `analisar`.
- **GPS:** só entram nos cálculos as linhas com fix 3D ou melhor (`Status >= 3`:
  3D, DGPS, RTK float, RTK fixo).
- **Altitude:** no dashboard, a altitude é sempre **em relação ao solo**. O solo
  é a mediana da leitura com o avião parado no minuto antes da decolagem.
  Barômetro e GPS aparecem juntos porque erram de formas diferentes. O
  barômetro sem espuma de proteção sente o fluxo de ar e a hélice. O GPS tem
  erro vertical de alguns metros, mas varia de forma suave. O resumo das
  análises (`statistics`) usa BARO e recorre ao GPS só quando o log não tem BARO
  (nesse caso, também só com as linhas com `Status >= 3`).
  A taxa vertical é calculada sobre médias de janelas de 1 s, para reduzir o
  ruído do sensor.
- **Vibração:** `Clip` é um contador acumulado, por isso o valor usado é o último
  registrado. Logs de firmware antigo (sem coluna `IMU`, com `Clip0/1/2`) também
  são suportados.
- **Histórico CSV:** cada voo ocupa uma linha, identificada pelo nome do arquivo.
  Processar o mesmo voo de novo substitui a linha anterior.
  **Atenção:** o ArduPilot numera os logs em sequência (`00000001.BIN`…) e a
  numeração recomeça ao formatar o cartão SD ou em outro drone. Dois voos
  diferentes com o mesmo nome se sobrescrevem no histórico, então renomeie os
  `.bin` com nomes únicos (ex: `2026-10-01_voo03.bin`) antes de exportar.

## Histórico de alterações

As mudanças são registradas aqui, da mais recente para a mais antiga.

### 2026-10-03 — documentação do analista e do primeiro voo

- README: passo a passo de **como fazer uma pergunta ao analista**, a seção
  **Voos analisados** (investigação da queda de 30/09, com o relato do piloto
  e a reanálise)
  e **Próximos passos**.
- Sem mudanças de código.

### 2026-10-02 — abas novas e analista de voo

**Novidades**
- `tests/gerar_voo_sintetico.py`: gera voos de teste (.bin, ~120 s) com defeitos
  conhecidos — `limpo`, `bateria_fraca`, `vibracao_alta`, `perda_gps`,
  `placa_invertida`, `impacto` — com IMU coerente com o GPS. Os voos e a ficha
  `aeronave_teste.toml` ficam em `tests/voos_sinteticos/`
  (`python tests/gerar_voo_sintetico.py --todos tests/voos_sinteticos`).
- Dashboard com **abas**: Voo, Explorador, Aerodinâmica, Replay 3D, Saúde do
  sistema e Vibração. Só a aba aberta é calculada; o log completo só é carregado
  quando uma aba precisa dele.
- Painel interativo genérico: o mesmo painel (barra de tempo, cursor
  sincronizado, valores instantâneos, zoom) atende todas as abas. Os títulos
  ficam em cima de cada gráfico, a legenda embaixo, e há linhas de limite
  tracejadas.
- **Unidades lidas do próprio log** (FMTU/UNIT/MULT), com o fator de escala
  aplicado só aos campos que o leitor ainda não escalou (ex.: `PM.Load` vem em
  décimos de %).
- **Agente analista de voo** (`.claude/agents/analista-voo.md`) com dossiê
  (`analysis/dossie.py`), consulta (`analysis/consulta.py`), detector de eventos
  (`analysis/eventos.py`) e ficha da aeronave (`aeronave.toml`,
  `analysis/ficha.py`).
- **Atitude recalculada da IMU** (`analysis/atitude.py`) e detecção automática
  de controladora montada ao contrário.
- `analysis/espectro.py` (espectro, espectrograma, batch sampler) e
  `analysis/aerodinamica.py` (vento, CL, fator de carga, Reynolds, estol).
- Resistência interna da bateria medida no degrau de aceleração do motor. No
  voo real deu 0,038 Ω, uma bateria saudável.

**Correções**
- Mensagens gravadas devagar (ex.: `PM`, a cada ~5 s) apareciam vazias nos
  gráficos: cada intervalo era tratado como falha do log. Agora "falha" é um
  intervalo maior que 3 s **e** maior que 3× o intervalo normal daquela
  mensagem.
- Quando o log já começa com o avião em movimento, a referência de solo da
  altitude usava a mediana do log inteiro. Agora usa os primeiros segundos.
- Vibração e clipping no instante de um impacto são separados da vibração em
  voo. Antes, um pico de 49 m/s² na batida parecia um problema do voo.

**Correções da revisão independente (código das abas e do analista)**
- Explorador: em `PIDR/PIDP/PIDY/TEC2` a coluna `I` é o termo integral, não a
  instância do sensor. Antes as séries ficavam com buracos (ou vazias, no
  TEC2). Agora só conta como instância uma coluna inteira com valores
  pequenos, e `Instance` (ESC, RFND...) também é reconhecida.
- Explorador: o CSV só é gerado no clique de download, não a cada interação.
  Os campos são recortados sem copiar a mensagem inteira.
- Origem do tempo única para a barra lateral e todas as abas.
- Replay 3D: o padrão "Altura por" (GPS quando o barômetro diverge) vale a cada
  trecho novo. O tubo do trajeto não some mais quando o avião está parado
  (pontos repetidos). A memória de vídeo é liberada a cada reconstrução, e a
  neblina e o alcance da câmera acompanham o tamanho do voo.
- Painel: com muitos campos (até 12) cada gráfico mantém ~100 px de altura.
- Mudanças em `aeronave.toml` passam a valer sem reiniciar o dashboard.
  `orientacao = ""` na ficha volta ao padrão em vez de dar erro.
- Aerodinâmica: monitor só de tensão mostra a potência como "sem medição" (antes, 0 W).
- Vibração: o espectro do batch sampler usa a mesma resolução em todos os
  lotes, e só a fonte escolhida é calculada.
- Atitude: a orientação da ficha não é aplicada de novo quando
  `AHRS_ORIENTATION` já corrige a montagem. `consulta --tipo ATITUDE` dá uma
  mensagem clara quando não há IMU suficiente.
- Eventos:
  - Avisos só de PreArm viram "info" e não decidem mais o veredito.
  - "EKF yaw aligned to GPS", que é normal, não gera mais alerta.
  - O clipping em voo soma só os aumentos durante o voo.
  - A vibração alta sai como um evento só, com os segundos acima de 30 e de 60.
  - Uma perda de GPS em voo não parte mais o voo em dois.
  - Entram como notas de qualidade: ARSP com sensor desativado e VIBE com
    valores que parecem aceleração bruta.
- `dossie`/`consulta` imprimem em UTF-8 no console do Windows.
- Agente `analista-voo`: regras de rigor vindas do exame com 6 voos de teste.
  - Número derivado mostra a conta.
  - Uma causa vira um único achado.
  - Hipótese não entra como fato.
  - Achado "info" não gera ajuste de parâmetro.
  - Atitude não calibrada limita a confiança.

### 2026-10-01 — altitude em relação ao solo

**Correções**
- No primeiro log real, a altitude do painel parecia acompanhar o pitch. A causa
  é o **barômetro da controladora**: em voo, ele sentia o fluxo de ar e da
  hélice. Isso gerava saltos de −8 m em 0,2 s e chegou a −16 m, enquanto o GPS
  mostrava uma subida suave até ~22 m. O painel agora mostra **barômetro e GPS
  juntos** (duas linhas no gráfico e dois cartões) e **avisa** quando eles
  discordam mais de 5 m durante o voo.
- A referência de altitude era a primeira leitura do log. No GPS, essa leitura
  costuma errar vários metros logo após o primeiro fix (neste log, ~5 m). Agora
  a referência é a **mediana com o avião parado no solo no minuto antes da
  decolagem**, igual para qualquer trecho escolhido. O trajeto do mapa e o
  "Resumo completo" usam a mesma referência.
- As métricas do topo mostram a altitude máxima pelas duas fontes.

### 2026-10-01 — dashboard interativo

**Novidades**
- Novo dashboard (`visualization/dashboard.py`) com escolha de arquivo e de trecho
  de tempo, detecção automática do trecho em voo e métricas do trecho.
- Painel interativo (`visualization/painel_voo.py` + `painel_voo_web/`): valores
  instantâneos, gráficos sincronizados de velocidade, altitude, tensão, corrente e
  potência, mapa com trajeto colorido e marcador da aeronave, barra de tempo com
  play/pause, velocidade de 0,25× a 30× e saltos de ±10 s, zoom com *Analisar
  trecho do zoom*, faixas de modo de voo, link para o Google Maps e exportação
  KML.
- Novo `visualization/dados_voo.py`: base de tempo comum a todos os sensores,
  recorte por trecho, redução de pontos que preserva picos, nomes dos modos de
  voo (Plane, Copter, Rover) e geração de KML.
- O dashboard lista arquivos `.bin` e `.BIN`. O ArduPilot grava em maiúsculas, e
  antes só `.bin` era encontrado em Linux e macOS.

**Performance**
- O parser decodifica cada tipo de mensagem de uma vez com numpy, usando o índice
  que o pymavlink monta ao abrir o arquivo. Antes era criado um objeto Python por
  mensagem. Num log de 30 min (18 MB), a leitura caiu de 15,8 s para 0,47 s (34×).
  O resultado é idêntico ao da leitura antiga, verificado em todos os tipos de
  mensagem. A leitura mensagem a mensagem continua como alternativa automática se
  algo falhar. O cache foi para a versão 2 e os caches antigos são refeitos sozinhos.
- No dashboard, o log fica em `st.cache_resource`, sem copiar os DataFrames a cada
  interação, e cada trecho em `st.cache_data`. Mudar o trecho processa só aquele
  pedaço: um trecho de 1 min de um log de 30 min é preparado em 0,02 s.
- Mover o mouse, reproduzir e trocar a velocidade não redesenham gráficos nem
  mapa. Isso foi verificado com contadores de redesenho em teste automatizado
  no navegador: zero redesenhos durante o uso.

**Correções (revisão independente do código novo)**
- Parser:
  - Num log com um trecho corrompido no meio (queda de energia, erro no cartão
    SD), a leitura rápida perdia tudo depois desse trecho. Agora ela detecta o
    problema e usa a leitura mensagem a mensagem, que pula o trecho ruim.
  - Logs que redefinem um tipo de mensagem (FMT repetido) eram decodificados
    com o formato errado. Agora cada parte usa a definição que valia ali.
  - Campos `uint64` muito grandes saíam negativos.
  - Um FMT com mais colunas do que campos derrubava a leitura inteira.
  - Um erro no meio da leitura deixava o `.bin` travado no Windows.
- Cache: o arquivo temporário agora tem nome único. Uma falha ao gravar o cache
  não derruba mais uma leitura que deu certo. Os caches antigos do mesmo log são
  apagados.
- Logs com mais de ~1–2 h: a redução de pontos era confundida com falha no log,
  e o avião sumia do mapa e os valores apareciam como "—". Agora as falhas reais
  (ex.: GPS sem fix) são marcadas antes da redução e aparecem como interrupção
  no trajeto e nos gráficos.
- Bateria:
  - Um log com BAT só na instância 1 derrubava a página.
  - Com monitor só de tensão (corrente NaN) ou um NaN isolado, o consumo virava
    "nan". Agora as amostras sem corrente são ignoradas na integral, e as
    métricas sem valor não aparecem.
- Dashboard:
  - A escolha do arquivo pulava para outro log quando chegava um arquivo novo
    na pasta.
  - Só os tipos de mensagem usados ficam em memória (antes, até 3 logs
    inteiros, com IMU).
  - Um registro de tempo corrompido esticava a duração do log.
  - Um log sem `TimeUS` (firmware antigo) mostrava um traceback em vez de uma
    mensagem clara.
  - "Analisar trecho do zoom" com menos de 1 s, ou com a faixa invertida, fazia
    o painel sumir.
  - A altitude máxima do "Resumo completo" usava outra referência e contradizia
    o cartão.
- Painel:
  - Com "Seguir aeronave" ligado, passar o mouse no trajeto fazia o mapa andar
    sozinho.
  - As dicas dos pontos de início e fim não apareciam.
  - Num trecho sem GPS, o aviso cobria os controles do mapa e o link do Google
    Maps apontava para o trecho anterior.

### 2026-10-01 — correções e performance

**Performance**
- `parser.ler_log` ganhou cache em `data/cache/`: o mesmo `.bin` não é lido duas vezes.
- `statistics.resumir_voo` e `exportar_csv.exportar_resumo_csv` aceitam `dados=`
  já carregados. O PDF e o export de CSV liam cada log duas vezes e agora leem uma.
- O parser passou a usar `recv_msg()` direto e fecha o arquivo ao terminar. Antes o
  `.bin` ficava preso e não podia ser movido nem apagado no Windows.
- O PDF usa o backend `Agg` do matplotlib, que só gera imagens e não abre janela.
- O dashboard relia e reanalisava o log a cada interação na tela, porque o resumo
  ficava fora do `st.cache_data`. Agora o log e o resumo são calculados uma vez e
  guardados juntos no cache.

**Correções**
- Logs com sensores redundantes misturavam as instâncias: a distância somava os
  saltos entre dois GPS, o consumo misturava duas baterias e o gráfico de altitude
  saía em zigue-zague. Foi criado `utils.filtrar_instancia()`, e todas as análises
  agora usam a instância 0.
- O filtro do GPS era `Status == 3` e descartava DGPS e RTK. Passou a ser `Status >= 3`.
- A análise de vibração quebrava em logs sem coluna `IMU` (firmware antigo) ou sem
  dados para a IMU pedida. Agora usa `Clip0/1/2` quando não há `Clip`.
- O histórico CSV comparava o caminho completo, então o mesmo voo processado em
  outra pasta ou máquina gerava uma linha duplicada. Agora compara pelo nome do
  arquivo, inclusive nas linhas antigas.
- `exportar_csv` aceita pastas passadas como texto (`str`), não só `Path`.
- `diag_voo` não quebra mais quando não há `.bin` ou mensagens VIBE.
- `battery.py` usava o caminho relativo fixo `data/logs`. Agora usa `config.PASTA_LOGS`.
- Foi removido dos módulos de `analysis/` um ajuste de `sys.path` que nunca
  funcionava. A forma de executá-los passou a ser `python -m analysis.<módulo>`.
- `numpy` foi adicionado ao `requirements.txt`.
- Os gráficos do dashboard (`visualization/plots.py`) também passaram a usar só a
  instância 0 de cada sensor. O de vibração não quebra mais em logs sem coluna `IMU`.
- Quando não há BARO, o cálculo de altitude pelo GPS ignorava o filtro de fix e
  usava como referência a altitude zerada de antes do fix. Agora também usa só as
  linhas com `Status >= 3`.
- `taxa_descida_maxima_ms` mostrava a menor taxa de subida como se fosse uma
  descida. Por exemplo, um voo que só subiu aparecia com descida de 1 m/s. Agora
  vale 0 quando não houve descida, e o mesmo vale para a subida.
