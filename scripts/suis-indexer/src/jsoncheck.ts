/**
 * Accept a single JSON value and reject duplicate keys at any object depth.
 * JSON.parse keeps the last duplicate, which would make two indexers diverge.
 */

function isWs(c: string): boolean {
  return c === " " || c === "\n" || c === "\r" || c === "\t";
}

/** `ok` when the text is one JSON value with unique keys. `dup` and `bad` both reject. */
export function classifyJson(text: string): "ok" | "dup" | "bad" {
  const n = text.length;
  let i = 0;
  let dup = false;

  function ws() {
    while (i < n && isWs(text[i]!)) i++;
  }

  function parseString(): string | null {
    if (text[i] !== '"') return null;
    i++;
    let out = "";
    while (i < n) {
      const c = text[i++]!;
      if (c === '"') return out;
      if (c === "\\") {
        if (i >= n) return null;
        const e = text[i++]!;
        if (e === '"' || e === "\\" || e === "/") out += e;
        else if (e === "b") out += "\b";
        else if (e === "f") out += "\f";
        else if (e === "n") out += "\n";
        else if (e === "r") out += "\r";
        else if (e === "t") out += "\t";
        else if (e === "u") {
          const hex = text.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else return null;
      } else if (c.charCodeAt(0) < 0x20) {
        return null;
      } else {
        out += c;
      }
    }
    return null;
  }

  function parseNumber(): boolean {
    const start = i;
    if (text[i] === "-") i++;
    if (text[i] === "0") i++;
    else if (text[i]! >= "1" && text[i]! <= "9") {
      while (i < n && text[i]! >= "0" && text[i]! <= "9") i++;
    } else return false;
    if (text[i] === ".") {
      i++;
      if (i >= n || text[i]! < "0" || text[i]! > "9") return false;
      while (i < n && text[i]! >= "0" && text[i]! <= "9") i++;
    }
    if (text[i] === "e" || text[i] === "E") {
      i++;
      if (text[i] === "+" || text[i] === "-") i++;
      if (i >= n || text[i]! < "0" || text[i]! > "9") return false;
      while (i < n && text[i]! >= "0" && text[i]! <= "9") i++;
    }
    return i > start;
  }

  function parseLiteral(): boolean {
    if (text.startsWith("true", i)) {
      i += 4;
      return true;
    }
    if (text.startsWith("false", i)) {
      i += 5;
      return true;
    }
    if (text.startsWith("null", i)) {
      i += 4;
      return true;
    }
    return false;
  }

  function parseValue(): boolean {
    ws();
    if (i >= n) return false;
    const c = text[i]!;
    if (c === "{") return parseObject();
    if (c === "[") return parseArray();
    if (c === '"') return parseString() !== null;
    if (c === "t" || c === "f" || c === "n") return parseLiteral();
    if (c === "-" || (c >= "0" && c <= "9")) return parseNumber();
    return false;
  }

  function parseObject(): boolean {
    i++;
    const seen = new Set<string>();
    ws();
    if (i < n && text[i] === "}") {
      i++;
      return true;
    }
    while (i < n) {
      ws();
      if (text[i] !== '"') return false;
      const key = parseString();
      if (key === null) return false;
      if (seen.has(key)) dup = true;
      seen.add(key);
      ws();
      if (text[i] !== ":") return false;
      i++;
      if (!parseValue()) return false;
      ws();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "}") {
        i++;
        return true;
      }
      return false;
    }
    return false;
  }

  function parseArray(): boolean {
    i++;
    ws();
    if (i < n && text[i] === "]") {
      i++;
      return true;
    }
    while (i < n) {
      if (!parseValue()) return false;
      ws();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "]") {
        i++;
        return true;
      }
      return false;
    }
    return false;
  }

  ws();
  if (!parseValue()) return "bad";
  ws();
  if (i !== n) return "bad";
  if (dup) return "dup";
  return "ok";
}

export function parseJsonValue(text: string): unknown | undefined {
  if (classifyJson(text) !== "ok") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}