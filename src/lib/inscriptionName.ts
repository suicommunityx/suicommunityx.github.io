/**
 * TICK and NAME Movescriptions store the human-readable string in
 * `metadata.content`, not in `tick` (`tick` is the literal "TICK" / "NAME").
 * That payload is BCS `metadata::TextMetadata`: vector<u8> text, u64 timestamp,
 * address miner. Content-type:
 * `application/bcs; type_name=…::metadata::TextMetadata`.
 * The decoded text is case-sensitive and is returned unchanged.
 */

const MAX_INSCRIPTION_NAME_LEN = 180;
/** u64 timestamp_ms + 32-byte miner address. */
const TEXT_METADATA_TAIL = 8 + 32;

export type NamedHolding = {
  tick: string;
  inscriptionName?: string | null;
};

/** Label shown on a holding row. Metadata text wins over the protocol tick. */
export function holdingLabel(h: NamedHolding): string {
  const name = h.inscriptionName;
  if (typeof name === 'string' && name.length > 0) return name;
  return h.tick;
}

function acceptName(text: string | null): string | null {
  if (text == null) return null;
  if (text.length === 0 || text.length > MAX_INSCRIPTION_NAME_LEN) return null;
  if (text !== text.trim()) return null;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return null;
  }
  return text;
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function readUleb(bytes: Uint8Array, offset: number): { value: number; next: number } | null {
  let value = 0;
  let shift = 0;
  let i = offset;
  while (i < bytes.length && shift <= 28) {
    const b = bytes[i++];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value, next: i };
    shift += 7;
  }
  return null;
}

function toByteArray(content: unknown): Uint8Array | null {
  if (content instanceof Uint8Array) return content;
  if (Array.isArray(content)) {
    if (content.length === 0) return new Uint8Array();
    const out = new Uint8Array(content.length);
    for (let i = 0; i < content.length; i++) {
      const n = content[i];
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 255) return null;
      out[i] = n;
    }
    return out;
  }
  return null;
}

function fromBase64(content: string): Uint8Array | null {
  const s = content.trim();
  if (!s || !/^[A-Za-z0-9+/]+={0,2}$/.test(s) || s.length % 4 !== 0) return null;
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** First BCS vector<u8> when the remainder is exactly a TextMetadata tail. */
function textFromTextMetadata(bytes: Uint8Array): string | null {
  const len = readUleb(bytes, 0);
  if (!len) return null;
  const end = len.next + len.value;
  if (end > bytes.length) return null;
  if (bytes.length - end !== TEXT_METADATA_TAIL) return null;
  return acceptName(decodeUtf8(bytes.subarray(len.next, end)));
}

function metadataFields(metadata: unknown): { content: unknown; contentType: string } | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const rec = metadata as { fields?: unknown; content?: unknown; content_type?: unknown };
  const fields =
    rec.fields && typeof rec.fields === 'object'
      ? (rec.fields as { content?: unknown; content_type?: unknown })
      : rec;
  return {
    content: fields.content,
    contentType: typeof fields.content_type === 'string' ? fields.content_type : '',
  };
}

/**
 * Human-readable inscription string from a Movescription `metadata` field.
 * Returns null when the object has no text metadata (ordinary ticks such as MOVE).
 */
export function readInscriptionName(metadata: unknown): string | null {
  const fields = metadataFields(metadata);
  if (!fields) return null;
  const ct = fields.contentType.toLowerCase();
  const isBcs = ct.includes('textmetadata') || ct.includes('application/bcs') || ct.includes('/bcs');
  const isText = ct.startsWith('text/');

  if (isText && typeof fields.content === 'string') {
    return acceptName(fields.content);
  }

  let bytes = toByteArray(fields.content);
  if (!bytes && typeof fields.content === 'string' && (isBcs || ct === '')) {
    bytes = fromBase64(fields.content);
  }
  if (!bytes || bytes.length === 0) return null;

  if (isBcs || ct === '') {
    const name = textFromTextMetadata(bytes);
    if (name) return name;
    if (isBcs) return null;
  }
  if (isText) return acceptName(decodeUtf8(bytes));
  return null;
}

/** ascii::String / std::string as returned by Sui JSON-RPC. Preserves case. */
export function readMoveString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const rec = value as { value?: unknown; fields?: { value?: unknown } };
    const inner = rec.value ?? rec.fields?.value;
    if (typeof inner === 'string') return inner;
  }
  return '';
}
