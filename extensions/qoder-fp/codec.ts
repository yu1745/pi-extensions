/**
 * Qoder 请求体编解码器（逐字节复刻官方算法）
 * 依据对 Qoder CLI 抓包与开源还原逆向实测：
 * - 64 字符自定义字母表 Base64
 * - 填充字符为 '$'，数值 63 字符为 '!'
 * - 字符串切片前后 1/3 对调（swapBodyOuterThirds）
 */

export const BODY_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
export const BODY_PAD = "$";
export const BODY_PAD_VALUE = 63;

const ALPHABET_INDEX = new Int8Array(256).fill(-1);
for (let i = 0; i < BODY_ALPHABET.length; i++) {
  ALPHABET_INDEX[BODY_ALPHABET.charCodeAt(i)] = i;
}

export function swapBodyOuterThirds(s: string): string {
  const third = Math.floor(s.length / 3);
  if (third === 0) return s;
  return s.slice(s.length - third) + s.slice(third, s.length - third) + s.slice(0, third);
}

export function encodeBody(data: Buffer | Uint8Array): string {
  let acc = 0;
  let nb = 0;
  let out = "";

  const emit = (v: number) => {
    if (v === BODY_PAD_VALUE) {
      out += "!";
    } else {
      out += BODY_ALPHABET[v];
    }
  };

  for (let i = 0; i < data.length; i++) {
    acc = (acc << 8) | data[i];
    nb += 8;
    while (nb >= 6) {
      nb -= 6;
      emit((acc >> nb) & 0x3f);
    }
  }

  if (nb > 0) {
    emit((acc << (6 - nb)) & 0x3f);
  }

  while (out.length % 4 !== 0) {
    out += BODY_PAD;
  }

  return out;
}

export function encodeRequestBody(plaintext: Buffer | string): string {
  const buf = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const encoded = encodeBody(buf);
  return swapBodyOuterThirds(encoded);
}

function decodeGroup(grp: string): number[] {
  const vals: number[] = [];
  for (let i = 0; i < grp.length; i++) {
    const c = grp[i];
    if (c === "$") continue;
    if (c === "!") {
      vals.push(BODY_PAD_VALUE);
    } else {
      const idx = ALPHABET_INDEX[c.charCodeAt(0)];
      if (idx !== -1) {
        vals.push(idx);
      }
    }
  }
  const nv = vals.length;
  if (nv === 0) return [];
  let x = 0;
  for (const v of vals) {
    x = (x << 6) | v;
  }
  const nb = Math.floor((6 * nv) / 8);
  const out: number[] = [];
  for (let k = 0; k < nb; k++) {
    const sh = 6 * nv - 8 * (k + 1);
    out.push((x >> sh) & 0xff);
  }
  return out;
}

export function decodeBody(s: string): Buffer {
  const out: number[] = [];
  for (let i = 0; i + 4 <= s.length; i += 4) {
    const b = decodeGroup(s.slice(i, i + 4));
    if (b.length > 0) {
      out.push(...b);
    }
  }
  return Buffer.from(out);
}

export function decodeRequestBody(wire: string): Buffer {
  const unswapped = swapBodyOuterThirds(wire);
  return decodeBody(unswapped);
}
