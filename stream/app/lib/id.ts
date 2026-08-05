const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Sortable, prefixed ids (UUIDv7 payload in Crockford base32).
 *
 * Setup documents reference `devices.id`, and the document travels to the OBS
 * extension and into AI prompts, so ids need to survive being read aloud and
 * pasted around. The prefix makes a stray id self-describing in a diagnostic.
 */
export const ID_PREFIXES = {
  model: "mdl",
  port: "prt",
  bus: "bus",
  device: "dev",
  event: "evt",
  setup: "stp",
  revision: "rev",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

function uuidv7Bytes(): Uint8Array {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const ms = BigInt(Date.now());
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes;
}

function encodeBase32(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  const chars = new Array<string>(26);
  for (let i = 25; i >= 0; i--) {
    chars[i] = ALPHABET[Number(n & 31n)];
    n >>= 5n;
  }
  return chars.join("");
}

export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${encodeBase32(uuidv7Bytes())}`;
}

/**
 * Ids for nodes, links and spaces inside a setup document. These are short and
 * human-typeable because people hand-edit the JSON tab; they only need to be
 * unique within one document.
 */
export function newDocId(prefix: "n" | "l" | "sp", taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let i = 1; ; i++) {
    const candidate = `${prefix}${i}`;
    if (!used.has(candidate)) return candidate;
  }
}
