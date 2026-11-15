/**
 * zip.ts — arquivo .zip sem compressão (método "store"), o suficiente para
 * juntar vários CSVs num download só, sem dependência externa.
 */
const TABELA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = TABELA_CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dataDos(d: Date): [number, number] {
  const hora = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dia = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return [hora, dia];
}

/** Monta o .zip com os arquivos dados (nome → conteúdo em texto). */
export function zipar(arquivos: Record<string, string>, agora = new Date()): Uint8Array {
  const enc = new TextEncoder();
  const [hora, dia] = dataDos(agora);
  const locais: Uint8Array[] = [];
  const centrais: Uint8Array[] = [];
  let pos = 0;
  for (const [nome, texto] of Object.entries(arquivos)) {
    const n = enc.encode(nome), dados = enc.encode(texto), crc = crc32(dados);
    const local = new Uint8Array(30 + n.length);
    const v = new DataView(local.buffer);
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true); // UTF-8
    v.setUint16(8, 0, true); v.setUint16(10, hora, true); v.setUint16(12, dia, true);
    v.setUint32(14, crc, true); v.setUint32(18, dados.length, true); v.setUint32(22, dados.length, true);
    v.setUint16(26, n.length, true); v.setUint16(28, 0, true);
    local.set(n, 30);
    const central = new Uint8Array(46 + n.length);
    const c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true); c.setUint16(12, hora, true); c.setUint16(14, dia, true);
    c.setUint32(16, crc, true); c.setUint32(20, dados.length, true); c.setUint32(24, dados.length, true);
    c.setUint16(28, n.length, true); c.setUint32(42, pos, true);
    central.set(n, 46);
    locais.push(local, dados);
    centrais.push(central);
    pos += local.length + dados.length;
  }
  const tamCentral = centrais.reduce((s, x) => s + x.length, 0);
  const fim = new Uint8Array(22);
  const f = new DataView(fim.buffer);
  f.setUint32(0, 0x06054b50, true);
  f.setUint16(8, centrais.length, true); f.setUint16(10, centrais.length, true);
  f.setUint32(12, tamCentral, true); f.setUint32(16, pos, true);
  const total = new Uint8Array(pos + tamCentral + 22);
  let o = 0;
  for (const p of [...locais, ...centrais, fim]) { total.set(p, o); o += p.length; }
  return total;
}
