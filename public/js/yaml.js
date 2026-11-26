// A small YAML subset parser — enough for LRCLIB's "Lyricsfile" documents
// (block mappings and sequences, plain/quoted scalars, block scalars, simple flow
// collections). It is not a general YAML implementation; callers should fall back
// gracefully if it throws.

const KEY_RE = /^([A-Za-z_$][\w.$-]*|'(?:[^']|'')*'|"(?:[^"\\]|\\.)*")\s*:(?:[ \t]+(.*))?$/;

function unquoteKey(k) {
  if (k.startsWith("'")) return k.slice(1, -1).replace(/''/g, "'");
  if (k.startsWith('"')) return JSON.parse(k);
  return k;
}

function plainValue(s) {
  const v = s.trim();
  if (v === '' || v === '~' || v === 'null' || v === 'Null' || v === 'NULL') return null;
  if (/^(true|True|TRUE)$/.test(v)) return true;
  if (/^(false|False|FALSE)$/.test(v)) return false;
  if (/^[-+]?\d+$/.test(v)) return parseInt(v, 10);
  if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(v)) return parseFloat(v);
  return v;
}

function unescapeDouble(body) {
  return body.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, e) => {
    switch (e[0]) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '0': return '\0';
      case 'x': case 'u': case 'U': return String.fromCodePoint(parseInt(e.slice(1), 16));
      case ' ': return ' ';
      case '/': return '/';
      default: return e; // \\ and \"
    }
  });
}

/** Fold a multi-line quoted scalar: single line breaks become spaces, blank lines become \n. */
function fold(raw) {
  if (!raw.includes('\n')) return raw; // single line: keep spaces exactly (e.g. 'word ')
  const parts = raw.split('\n');
  return parts
    .map((l, i) => {
      let s = i > 0 ? l.trimStart() : l;
      if (i < parts.length - 1) s = s.replace(/[ \t]+$/, '');
      return s;
    })
    .reduce((acc, l, i) => (i === 0 ? l : acc + (l === '' ? '\n' : acc.endsWith('\n') ? l : ` ${l}`)), '');
}

export function parseYaml(src) {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  let i = 0;

  const indentOf = (s) => s.length - s.trimStart().length;
  const isBlank = (s) => /^\s*(#.*)?$/.test(s);
  const isSeqItem = (rest) => rest === '-' || rest.startsWith('- ');
  const skipBlank = () => {
    while (i < lines.length && isBlank(lines[i])) i++;
  };

  function parseNode(indent) {
    skipBlank();
    if (i >= lines.length) return null;
    const ind = indentOf(lines[i]);
    if (ind < indent) return null;
    const rest = lines[i].slice(ind);
    return isSeqItem(rest) ? parseSeq(ind) : parseMap(ind);
  }

  function parseSeq(ind) {
    const arr = [];
    for (;;) {
      skipBlank();
      if (i >= lines.length) break;
      const li = indentOf(lines[i]);
      const rest = lines[i].slice(li);
      if (li !== ind || !isSeqItem(rest)) break;
      const after = rest === '-' ? '' : rest.slice(2);
      if (after.trim() === '') {
        i++;
        arr.push(parseNode(ind + 1));
      } else if (KEY_RE.test(after.trimStart())) {
        // "- key: value" starts a mapping whose keys line up after the dash.
        const itemIndent = ind + 2 + indentOf(after);
        lines[i] = ' '.repeat(itemIndent) + after.trimStart();
        arr.push(parseMap(itemIndent));
      } else {
        i++;
        arr.push(parseInlineValue(after.trim(), ind));
      }
    }
    return arr;
  }

  function parseMap(ind) {
    const obj = {};
    for (;;) {
      skipBlank();
      if (i >= lines.length) break;
      const li = indentOf(lines[i]);
      const rest = lines[i].slice(li);
      if (li !== ind || isSeqItem(rest)) break;
      const m = rest.match(KEY_RE);
      if (!m) throw new SyntaxError(`YAML: expected "key:" on line ${i + 1}`);
      const key = unquoteKey(m[1]);
      const value = m[2] ?? '';
      i++;
      if (value.trim() === '' || /^#/.test(value.trim())) {
        skipBlank();
        if (i < lines.length) {
          const ni = indentOf(lines[i]);
          const nrest = lines[i].slice(ni);
          if (ni > ind || (ni === ind && isSeqItem(nrest))) {
            obj[key] = parseNode(ni);
            continue;
          }
        }
        obj[key] = null;
      } else if (/^[|>][+-]?\d*$/.test(value.trim())) {
        obj[key] = parseBlockScalar(value.trim(), ind);
      } else {
        obj[key] = parseInlineValue(value.trim(), ind);
      }
    }
    return obj;
  }

  /** A scalar or flow collection starting on the current (already consumed) line. */
  function parseInlineValue(text, ind) {
    if (text.startsWith("'") || text.startsWith('"')) {
      const q = text[0];
      let raw = text;
      const closed = (s) => {
        const body = s.slice(1);
        if (q === "'") return /^(?:[^']|'')*'\s*(#.*)?$/.test(body);
        return /^(?:[^"\\]|\\[\s\S])*"\s*(#.*)?$/.test(body);
      };
      while (!closed(raw) && i < lines.length) raw += `\n${lines[i++]}`;
      const end = raw.lastIndexOf(q);
      const body = fold(raw.slice(1, end));
      return q === "'" ? body.replace(/''/g, "'") : unescapeDouble(body);
    }
    if (text.startsWith('[') || text.startsWith('{')) return parseFlow(text);
    // Plain scalar, possibly continued on more-indented lines.
    let value = text.replace(/\s+#.*$/, '');
    while (i < lines.length && !isBlank(lines[i]) && indentOf(lines[i]) > ind) {
      const cont = lines[i].trim();
      if (KEY_RE.test(cont) || isSeqItem(cont)) break;
      value += ` ${cont}`;
      i++;
    }
    return plainValue(value);
  }

  function parseBlockScalar(header, ind) {
    const folded = header[0] === '>';
    const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip';
    const body = [];
    let contentIndent = -1;
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === '') {
        body.push('');
        i++;
        continue;
      }
      const li = indentOf(l);
      if (li <= ind) break;
      if (contentIndent < 0) contentIndent = li;
      if (li < contentIndent) break;
      body.push(l.slice(contentIndent));
      i++;
    }
    // Trailing blank lines belong to chomping, not content.
    let trailing = 0;
    while (body.length && body[body.length - 1] === '') {
      body.pop();
      trailing++;
    }
    let text = folded
      ? body.reduce((acc, l, k) => (k === 0 ? l : acc + (l === '' ? '\n' : acc.endsWith('\n') ? l : ` ${l}`)), '')
      : body.join('\n');
    if (chomp === 'clip' && body.length) text += '\n';
    if (chomp === 'keep') text += '\n'.repeat(trailing + 1);
    return text;
  }

  return parseNode(0);
}

/** Minimal flow-collection parser: [a, 'b', {k: v}] and {k: v, k2: [1, 2]}. */
export function parseFlow(text) {
  let p = 0;
  const s = text.trim();
  const ws = () => {
    while (p < s.length && /\s/.test(s[p])) p++;
  };
  function value() {
    ws();
    const c = s[p];
    if (c === '[') {
      p++;
      const arr = [];
      ws();
      if (s[p] === ']') return p++, arr;
      for (;;) {
        arr.push(value());
        ws();
        if (s[p] === ',') p++;
        else if (s[p] === ']') return p++, arr;
        else throw new SyntaxError('YAML flow: expected , or ]');
      }
    }
    if (c === '{') {
      p++;
      const obj = {};
      ws();
      if (s[p] === '}') return p++, obj;
      for (;;) {
        ws();
        const k = scalar(true);
        ws();
        if (s[p] !== ':') throw new SyntaxError('YAML flow: expected :');
        p++;
        obj[k] = value();
        ws();
        if (s[p] === ',') p++;
        else if (s[p] === '}') return p++, obj;
        else throw new SyntaxError('YAML flow: expected , or }');
      }
    }
    return scalar(false);
  }
  function scalar(isKey) {
    ws();
    const c = s[p];
    if (c === "'" || c === '"') {
      let j = p + 1;
      let out = '';
      for (; j < s.length; j++) {
        if (c === "'" && s[j] === "'" && s[j + 1] === "'") {
          out += "'";
          j++;
        } else if (c === '"' && s[j] === '\\') {
          out += s[j] + s[j + 1];
          j++;
        } else if (s[j] === c) break;
        else out += s[j];
      }
      p = j + 1;
      return c === '"' ? unescapeDouble(out) : out;
    }
    let j = p;
    while (j < s.length && !(isKey ? /[:,}\]]/ : /[,}\]]/).test(s[j])) j++;
    const raw = s.slice(p, j);
    p = j;
    return isKey ? raw.trim() : plainValue(raw);
  }
  const v = value();
  return v;
}
