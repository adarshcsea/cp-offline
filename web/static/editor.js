/* CP Offline - lightweight code editor.
 *
 * A plain <textarea> (so copy/paste, undo/redo, IME, selection and the context
 * menu are all native) with a transparent-text overlay that draws syntax
 * colours, line numbers, current-line and bracket highlights.
 * No dependencies. The editing logic ("core") is pure string -> edit functions
 * so it can be unit-tested in Node (see runner/tests/test_editor_core.js).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CPEditor = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const UNIT = "    ";
  const OPEN = { "(": ")", "[": "]", "{": "}" };
  const CLOSE = { ")": "(", "]": "[", "}": "{" };

  /* ====================================================== tokenizer ====== */
  const PY_KW = new Set("False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(" "));
  const PY_BI = new Set("print input range len int str float list dict set tuple sorted sum min max abs map filter zip enumerate reversed open bool bytes chr ord divmod pow round any all isinstance type iter next id hash format slice frozenset bin hex oct complex object super self cls".split(" "));
  const CPP_KW = new Set("alignas alignof and asm auto break case catch class const consteval constexpr const_cast continue decltype default delete do dynamic_cast else enum explicit export extern for friend goto if inline mutable namespace new noexcept not operator or private protected public register reinterpret_cast return sizeof static static_assert static_cast struct switch template this throw try typedef typeid typename union using virtual volatile while xor".split(" "));
  const CPP_TY = new Set("bool char char8_t char16_t char32_t double float int long short signed unsigned void wchar_t size_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t ll ull ld string vector map set multiset multimap unordered_map unordered_set pair tuple array deque queue stack priority_queue bitset list optional cin cout cerr endl istream ostream stringstream ios iterator __int128 std".split(" "));
  const CPP_LIT = new Set(["true", "false", "nullptr", "NULL"]);

  const isIdStart = (c) => /[A-Za-z_]/.test(c);
  const isId = (c) => /\w/.test(c);
  const isDigit = (c) => c >= "0" && c <= "9";

  /** scan(text, lang) -> [[start, end, cls], ...] (only coloured spans). */
  function scan(t, lang) {
    const out = [], n = t.length;
    const py = lang === "python";
    let i = 0, prevWord = "";
    const push = (a, b, c) => out.push([a, b, c]);
    while (i < n) {
      const c = t[i];
      /* comments */
      if (py && c === "#") { const e = eol(t, i); push(i, e, "com"); i = e; continue; }
      if (!py && c === "/" && t[i + 1] === "/") { const e = eol(t, i); push(i, e, "com"); i = e; continue; }
      if (!py && c === "/" && t[i + 1] === "*") { let e = t.indexOf("*/", i + 2); e = e < 0 ? n : e + 2; push(i, e, "com"); i = e; continue; }
      /* preprocessor (C++) */
      if (!py && c === "#" && /^[ \t]*$/.test(t.slice(t.lastIndexOf("\n", i - 1) + 1, i))) {
        let j = i + 1; while (j < n && /[ \t]/.test(t[j])) j++;
        let k = j; while (k < n && isId(t[k])) k++;
        push(i, k, "pp");
        if (t.slice(j, k) === "include") {
          let m = k; while (m < n && /[ \t]/.test(t[m])) m++;
          if (t[m] === "<") { const e = t.indexOf(">", m); const end = e < 0 || t.slice(m, e).includes("\n") ? eol(t, m) : e + 1; push(m, end, "str"); k = end; }
        }
        i = k; continue;
      }
      /* strings */
      let q = -1, pre = 0;
      if (c === '"' || c === "'") q = i;
      else if (isIdStart(c) && (i === 0 || !isId(t[i - 1]))) {
        const m = (py ? /^[rRbBuUfF]{1,2}(?=["'])/ : /^(?:u8|[uUL])?R?(?=["'])/).exec(t.slice(i, i + 4));
        if (m && m[0].length) { pre = m[0].length; q = i + pre; }
      }
      if (q >= 0) {
        const quote = t[q];
        const raw = !py && quote === '"' && pre > 0 && /R$/.test(t.slice(i, q));
        let e;
        if (raw) {                                  // C++ raw string R"(...)"
          const open = t.indexOf("(", q), delim = open < 0 ? "" : t.slice(q + 1, open);
          const close = t.indexOf(")" + delim + '"', open);
          e = open < 0 || close < 0 ? n : close + delim.length + 2;
        } else if (py && t.startsWith(quote.repeat(3), q)) {
          e = q + 3;
          while (e < n && !t.startsWith(quote.repeat(3), e)) e += t[e] === "\\" ? 2 : 1;
          e = Math.min(n, e + 3);
        } else {
          e = q + 1;
          while (e < n && t[e] !== quote && t[e] !== "\n") e += t[e] === "\\" ? 2 : 1;
          if (t[e] === quote) e++;
          e = Math.min(e, n);
        }
        push(i, e, "str"); i = e; prevWord = ""; continue;
      }
      /* numbers */
      if (isDigit(c) || (c === "." && isDigit(t[i + 1] || ""))) {
        const re = py ? /^(?:0[xXoObB][\da-fA-F_]+|(?:\d[\d_]*)?\.?\d[\d_]*(?:[eE][+-]?\d+)?[jJ]?|\d[\d_]*\.)/
          : /^(?:0[xXbB][\da-fA-F']+[uUlL]*|(?:\d[\d']*)?\.?\d[\d']*(?:[eE][+-]?\d+)?[fFuUlL]*|\d[\d']*\.)/;
        const m = re.exec(t.slice(i, i + 64));
        const len = m && m[0].length ? m[0].length : 1;
        push(i, i + len, "num"); i += len; prevWord = ""; continue;
      }
      /* decorators */
      if (py && c === "@" && /^[ \t]*$/.test(t.slice(t.lastIndexOf("\n", i - 1) + 1, i))) {
        let k = i + 1; while (k < n && (isId(t[k]) || t[k] === ".")) k++;
        push(i, k, "dec"); i = k; continue;
      }
      /* identifiers */
      if (isIdStart(c)) {
        let k = i + 1; while (k < n && isId(t[k])) k++;
        const w = t.slice(i, k);
        let cls = "";
        if (py) {
          if (PY_KW.has(w)) cls = "kw";
          else if (prevWord === "def" || prevWord === "class") cls = "fn";
          else if (PY_BI.has(w)) cls = "bi";
          else if (nextNonSpace(t, k) === "(") cls = "fn";
        } else {
          if (CPP_KW.has(w)) cls = "kw";
          else if (CPP_LIT.has(w)) cls = "lit";
          else if (CPP_TY.has(w)) cls = "bi";
          else if (nextNonSpace(t, k) === "(") cls = "fn";
          else if (/^[A-Z][A-Z0-9_]{2,}$/.test(w)) cls = "lit";
        }
        if (cls) push(i, k, cls);
        prevWord = w; i = k; continue;
      }
      if (c !== " " && c !== "\t") prevWord = "";
      i++;
    }
    return out;
  }
  function eol(t, i) { const e = t.indexOf("\n", i); return e < 0 ? t.length : e; }
  function nextNonSpace(t, i) { while (i < t.length && (t[i] === " " || t[i] === "\t")) i++; return t[i]; }

  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
  const escHtml = (s) => s.replace(/[&<>]/g, (c) => ESC[c]);

  function highlight(t, lang) {
    if (t.length > 250000) return escHtml(t);
    const spans = getSpans(t, lang).spans;
    let html = "", pos = 0;
    for (const [a, b, cls] of spans) {
      if (a > pos) html += escHtml(t.slice(pos, a));
      html += `<span class="tk-${cls}">${escHtml(t.slice(a, b))}</span>`;
      pos = b;
    }
    return html + escHtml(t.slice(pos));
  }

  /* strings/comments mask, so bracket matching and auto-pairing skip them */
  let maskCache = { text: null, lang: null, mask: null, spans: null };
  function getSpans(t, lang) {
    if (maskCache.text === t && maskCache.lang === lang) return maskCache;
    const spans = scan(t, lang), mask = new Uint8Array(t.length);
    for (const [a, b, cls] of spans) if (cls === "str" || cls === "com") mask.fill(1, a, b);
    maskCache = { text: t, lang, mask, spans };
    return maskCache;
  }
  /** Span [a,b,cls] when pos is strictly inside a string/comment, else null. */
  function literalAt(t, pos, lang) {
    for (const sp of getSpans(t, lang).spans) {
      if (sp[0] < pos && pos < sp[1] && (sp[2] === "str" || sp[2] === "com")) return sp;
      if (sp[0] >= pos) break;
    }
    return null;
  }
  /** Span when pos is inside a string/comment (caret at the end of a line comment or of an unterminated string counts as inside). */
  function inCommentOrString(t, pos, lang) {
    for (const sp of getSpans(t, lang).spans) {
      if (sp[0] >= pos) break;
      if (sp[2] !== "str" && sp[2] !== "com") continue;
      if (pos < sp[1]) return sp;
      if (pos === sp[1]) {
        const body = t.slice(sp[0], sp[1]);
        if (sp[2] === "com") { if (!body.endsWith("*/") || body === "/*/") return sp; }
        else {
          const b = body.replace(/^[A-Za-z0-9]*/, ""), qq = b[0];
          const triple = b.startsWith(qq.repeat(3)) && b.length >= 3;
          const closed = triple ? b.length >= 6 && b.endsWith(qq.repeat(3)) : b.length >= 2 && b.endsWith(qq) && !b.endsWith("\\" + qq);
          if (!closed) return sp;
        }
      }
    }
    return null;
  }

  /* =========================================================== helpers === */
  const lineStartOf = (t, i) => t.lastIndexOf("\n", i - 1) + 1;
  const lineEndOf = (t, i) => { const k = t.indexOf("\n", i); return k < 0 ? t.length : k; };
  const leadWs = (s) => /^[ \t]*/.exec(s)[0];
  function vcol(str) { let c = 0; for (const ch of str) c = ch === "\t" ? c + 4 - (c % 4) : c + 1; return c; }

  /** Code part of a line: strings blanked, trailing comment removed. */
  function codePart(line, lang) {
    let out = "", q = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === "\\") { out += "  "; i++; continue; } if (c === q) { q = null; out += c; } else out += " "; continue; }
      if (c === '"' || (c === "'" && !(lang === "cpp" && i > 0 && /[0-9A-Za-z]/.test(line[i - 1])))) { q = c; out += c; continue; }
      if (lang === "python" && c === "#") break;
      if (lang === "cpp" && c === "/" && line[i + 1] === "/") break;
      if (lang === "cpp" && c === "/" && line[i + 1] === "*") {
        const e = line.indexOf("*/", i + 2);
        if (e < 0) break;
        out += " ".repeat(e + 2 - i); i = e + 1; continue;
      }
      out += c;
    }
    return out.replace(/\s+$/, "");
  }
  function netOpen(code) {
    let d = 0;
    for (const c of code) { if (OPEN[c]) d++; else if (CLOSE[c]) d--; }
    return d;
  }
  const dedentOnce = (ind) => (ind.endsWith("\t") ? ind.slice(0, -1) : ind.slice(0, Math.max(0, ind.length - 4)));

  /** Edits that rewrite whole lines and must keep the selection sensible. */
  function lineEdit(t, s, e, fn) {
    const ls = lineStartOf(t, s);
    let last = e;
    if (e > s && t[e - 1] === "\n") last = e - 1;
    const le = lineEndOf(t, last);
    const lines = t.slice(ls, le).split("\n");
    const starts = []; let p = ls;
    for (const l of lines) { starts.push(p); p += l.length + 1; }
    const ch = lines.map((l, i) => fn(l, i, lines));      // {line, col, delta}
    const block = ch.map((c) => c.line).join("\n");
    // new start offset of each line
    const nstarts = []; let q = ls;
    for (const c of ch) { nstarts.push(q); q += c.line.length + 1; }
    const map = (pos, isStart) => {
      let k = starts.length - 1;
      while (k > 0 && starts[k] > pos) k--;
      const col = pos - starts[k], c = ch[k];
      let ncol = col;
      if (c.delta > 0 && (isStart && s !== e ? col > c.col : col >= c.col)) ncol = col + c.delta;
      else if (c.delta < 0 && col > c.col) ncol = Math.max(c.col, col + c.delta);
      return nstarts[k] + ncol;
    };
    return { from: ls, to: le, insert: block, selStart: map(s, true), selEnd: map(e, false) };
  }

  /* ========================================================= Tab keys ==== */
  function tabEdit(t, s, e, shift) {
    if (s === e && !shift) {
      const ls = lineStartOf(t, s);
      const n = 4 - (vcol(t.slice(ls, s)) % 4);
      return { from: s, to: e, insert: " ".repeat(n) };
    }
    const multi = t.slice(s, e).includes("\n");
    if (!shift) {
      return lineEdit(t, s, e, (l) => (multi && l.trim() === "" ? { line: l, col: 0, delta: 0 } : { line: UNIT + l, col: 0, delta: 4 }));
    }
    return lineEdit(t, s, e, (l) => {
      let r = 0;
      if (l[0] === "\t") r = 1;
      else while (r < 4 && l[r] === " ") r++;
      return { line: l.slice(r), col: 0, delta: -r };
    });
  }

  /* =========================================================== Enter ==== */
  const PY_DEDENT_AFTER = /^\s*(return|pass|break|continue|raise)\b/;
  const CPP_CTRL_PAREN = /^\s*(\}\s*)?(else\s+if|if|for|while|switch)\b.*\)\s*$/;
  const CPP_CTRL_BARE = /^\s*(\}\s*)?(else|do)\s*$/;
  const CPP_CASE = /^\s*(case\b[^:]*|default\s*):$/;

  function isBracelessHeader(code) {
    if (CPP_CTRL_BARE.test(code)) return true;
    return CPP_CTRL_PAREN.test(code) && netOpen(code.replace(/^\s*\}/, "")) === 0 && !code.endsWith(";");
  }

  function onEnter(t, s, e, lang) {
    const ls = lineStartOf(t, s);
    const before = t.slice(ls, s);
    const indent = leadWs(before);
    const afterWs = leadWs(t.slice(e, lineEndOf(t, e)));
    const to = e + afterWs.length;                       // swallow whitespace right of the caret
    let lit = literalAt(t, s, lang);
    if (!lit) { const sp = inCommentOrString(t, s, lang); if (sp && sp[2] === "com" && t.startsWith("/*", sp[0])) lit = sp; }   // unterminated /* at caret
    const lineComment = lit && lit[2] === "com" && (t[lit[0]] === "#" || t.startsWith("//", lit[0]));
    if (lit && !lineComment) {                           // inside a string or block comment: keep it simple
      let extra = "";
      if (lang === "cpp" && lit[2] === "com") {
        const tb = before.trim();
        if (tb.startsWith("/*")) extra = " * "; else if (tb.startsWith("*")) extra = "* ";
      }
      return { from: s, to, insert: "\n" + indent + extra };
    }
    const code = codePart(before, lang);
    const trimmedBefore = before.replace(/[ \t]+$/, "");
    const wsOnly = before.length > 0 && before.trim() === "";
    let from = s;
    if (wsOnly) from = ls; else if (trimmedBefore.length < before.length) from = ls + trimmedBefore.length;

    let next = wsOnly ? before : indent;
    const depth = netOpen(code);
    const endsOpen = /[(\[{]$/.test(code);

    // bracket expansion:  {|}  ->  {\n    |\n}
    const cb = t[s - 1], ca = t[e];
    if (OPEN[cb] && OPEN[cb] === ca && e === s) {
      const inner = next + UNIT;
      return { from, to: s, insert: "\n" + inner + "\n" + next, selStart: from + 1 + inner.length, selEnd: from + 1 + inner.length };
    }
    if (lang === "python") {
      if (endsOpen || (depth <= 0 && code.endsWith(":")) || code.endsWith("\\")) next += UNIT;
      else if (depth <= 0 && PY_DEDENT_AFTER.test(code) && next.length >= 1) next = dedentOnce(next);
    } else {
      if (endsOpen || CPP_CASE.test(code) || isBracelessHeader(code)) next += UNIT;
      else if (code.endsWith(";") && depth <= 0) {
        // end of a braceless if/for/while body -> back to the header's indent
        let cur = next, p = ls;
        for (let guard = 0; guard < 6; guard++) {
          let found = null;
          while (p > 0) {
            const ps = lineStartOf(t, p - 1), line = t.slice(ps, p - 1);
            p = ps;
            if (line.trim() !== "") { found = line; break; }
          }
          if (found === null) break;
          const fi = leadWs(found);
          if (fi.length < cur.length && isBracelessHeader(codePart(found, lang))) cur = fi; else break;
        }
        next = cur;
      }
    }
    const ins = "\n" + next;
    return { from, to, insert: ins };
  }

  /* ======================================================== Backspace ==== */
  function onBackspace(t, s, e, lang) {
    if (s !== e || s === 0) return null;
    const ls = lineStartOf(t, s), before = t.slice(ls, s);
    if (before.length > 0 && /^ +$/.test(before)) {
      const n = before.length % 4 || 4;
      return { from: s - n, to: s, insert: "" };
    }
    const p = t[s - 1], nx = t[s];
    if (OPEN[p] && OPEN[p] === nx) return { from: s - 1, to: s + 1, insert: "" };
    if ((p === '"' || p === "'") && nx === p && !/\w/.test(t[s - 2] || "") && !inCommentOrString(t, s - 1, lang)) return { from: s - 1, to: s + 1, insert: "" };
    return null;
  }

  /* ===================================================== typing chars ==== */
  const PY_OPENERS = {
    else: /^(if|elif|for|while|try|except)\b/, elif: /^(if|elif)\b/,
    except: /^(try|except)\b/, finally: /^(try|except|else)\b/,
  };
  function pythonElectricColon(t, s, lang) {
    const ls = lineStartOf(t, s), le = lineEndOf(t, s);
    if (t.slice(s, le).trim() !== "") return null;
    const line = t.slice(ls, s);
    const m = /^([ \t]*)(else|elif\b.*|except\b.*|finally)$/.exec(line);
    if (!m || inCommentOrString(t, s, lang)) return null;
    const kind = m[2].split(/\W/)[0], re = PY_OPENERS[kind];
    const cur = m[1].length;
    let p = ls, target = -1;
    while (p > 0) {
      const ps = lineStartOf(t, p - 1), pl = t.slice(ps, p - 1);
      p = ps;
      if (pl.trim() === "") continue;
      const ind = leadWs(pl).length;
      if (ind > cur) continue;
      if (re.test(pl.trim())) { target = ind; break; }
      if (ind < cur) break;                     // a lower-indent non-opener ends the search
    }
    if (target < 0 || target === cur) return null;
    const ind = " ".repeat(target);
    return { from: ls, to: s, insert: ind + line.trim() + ":" };
  }

  function matchOpenIndent(t, pos, lang) {
    // pos = index of a "}" to be typed; find its "{" and return that line's indent
    const { mask } = getSpans(t, lang);
    let d = 0;
    for (let i = pos - 1; i >= 0 && pos - i < 200000; i--) {
      if (mask[i]) continue;
      const c = t[i];
      if (c === "}") d++;
      else if (c === "{") { if (d === 0) return leadWs(t.slice(lineStartOf(t, i), lineEndOf(t, i))); d--; }
    }
    return null;
  }

  function onChar(t, s, e, ch, lang) {
    const isQuote = ch === '"' || ch === "'";
    if (e > s) {                                                   // wrap selection
      if (OPEN[ch] || isQuote) {
        const close = isQuote ? ch : OPEN[ch];
        return { from: s, to: e, insert: ch + t.slice(s, e) + close, selStart: s + 1, selEnd: e + 1 };
      }
      return null;
    }
    const nx = t[s], pv = t[s - 1];
    if ((CLOSE[ch] || isQuote) && nx === ch) {                     // type over the closer
      return { from: s, to: s, insert: "", selStart: s + 1, selEnd: s + 1 };
    }
    const okNext = nx === undefined || /[\s)\]};,:.>]/.test(nx);
    if (OPEN[ch]) {
      if (!okNext) return null;
      if (inCommentOrString(t, s, lang)) return null;
      return { from: s, to: s, insert: ch + OPEN[ch], selStart: s + 1, selEnd: s + 1 };
    }
    if (isQuote) {
      if (!okNext || inCommentOrString(t, s, lang)) return null;
      if (pv === ch) return null;                                  // triple quotes / empty string
      if (pv && /\w/.test(pv)) {
        const pre = t.slice(Math.max(0, s - 4), s);
        const prefixOk = lang === "python" ? /(^|\W)[rRbBuUfF]{1,2}$/.test(pre) : ch === '"' && /(^|\W)(u8R|LR|uR|UR|u8|[LuUR])$/.test(pre);
        if (!prefixOk) return null;
      }
      return { from: s, to: s, insert: ch + ch, selStart: s + 1, selEnd: s + 1 };
    }
    if (ch === ":" && lang === "python") {
      const ed = pythonElectricColon(t, s, lang);
      if (ed) { ed.selStart = ed.selEnd = ed.from + ed.insert.length; return ed; }
      return null;
    }
    if (ch === "}" && lang === "cpp") {
      const ls = lineStartOf(t, s), before = t.slice(ls, s);
      if (before.length > 0 && before.trim() === "" && nx !== "}") {
        const want = matchOpenIndent(t, s, lang);
        // "{" + Enter already added the closing "}" on the next line: reuse it instead of duplicating
        const le = lineEndOf(t, s);
        if (want !== null && t.slice(s, le).trim() === "" && le < t.length) {
          const nls = le + 1, nle = lineEndOf(t, nls), nline = t.slice(nls, nle);
          if (nline.trim() === "}" && leadWs(nline) === want) {
            const at = nls + want.length + 1;
            return { from: ls, to: at, insert: want + "}", selStart: ls + want.length + 1, selEnd: ls + want.length + 1 };
          }
        }
        if (want !== null && want !== before) return { from: ls, to: s, insert: want + "}" };
      }
    }
    return null;
  }

  /* ===================================================== comment toggle == */
  function toggleComment(t, s, e, lang) {
    const mark = lang === "python" ? "#" : "//";
    const ls = lineStartOf(t, s);
    const last = e > s && t[e - 1] === "\n" ? e - 1 : e;
    const lines = t.slice(ls, lineEndOf(t, last)).split("\n");
    const nb = lines.filter((l) => l.trim() !== "");
    const all = nb.length > 0 && nb.every((l) => l.trimStart().startsWith(mark));
    if (all) {
      return lineEdit(t, s, e, (l) => {
        const ind = leadWs(l).length;
        if (!l.trimStart().startsWith(mark)) return { line: l, col: 0, delta: 0 };
        const rm = mark.length + (l[ind + mark.length] === " " ? 1 : 0);
        return { line: l.slice(0, ind) + l.slice(ind + rm), col: ind, delta: -rm };
      });
    }
    const minInd = nb.length ? Math.min(...nb.map((l) => leadWs(l).length)) : 0;
    return lineEdit(t, s, e, (l) => (l.trim() === "" && lines.length > 1 ? { line: l, col: 0, delta: 0 }
      : { line: l.slice(0, minInd) + mark + " " + l.slice(minInd), col: minInd, delta: mark.length + 1 }));
  }

  /* ===================================================== bracket match === */
  function findMatch(t, caret, lang) {
    const { mask } = getSpans(t, lang);
    const tryAt = (i) => {
      const c = t[i];
      if (i < 0 || i >= t.length || mask[i]) return -1;
      if (OPEN[c]) {
        let d = 0;
        for (let k = i; k < t.length && k - i < 200000; k++) {
          if (mask[k]) continue;
          const x = t[k];
          if (x === c) d++; else if (x === OPEN[c]) { d--; if (d === 0) return k; }
        }
      } else if (CLOSE[c]) {
        let d = 0;
        for (let k = i; k >= 0 && i - k < 200000; k--) {
          if (mask[k]) continue;
          const x = t[k];
          if (x === c) d++; else if (x === CLOSE[c]) { d--; if (d === 0) return k; }
        }
      }
      return -1;
    };
    let m = tryAt(caret - 1);
    if (m >= 0) return [caret - 1, m];
    m = tryAt(caret);
    if (m >= 0) return [caret, m];
    return null;
  }

  const core = { UNIT, scan, highlight, tabEdit, onEnter, onBackspace, onChar, toggleComment, findMatch, codePart, vcol, lineStartOf, lineEndOf };

  /* ============================================================ DOM ====== */
  function mount(host, opt) {
    opt = opt || {};
    let lang = opt.lang || "python";
    host.classList.add("ed");
    host.innerHTML = `<div class="ed-gutter" aria-hidden="true"><div class="ed-gcl"></div><pre class="ed-gn">1</pre></div>
      <div class="ed-main"><div class="ed-layer" aria-hidden="true"><div class="ed-cl"></div><pre class="ed-hl"></pre><div class="ed-bm"></div><div class="ed-bm"></div></div>
      <textarea id="code" class="ed-ta" wrap="off" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" data-gramm="false" aria-label="Code editor"></textarea></div>`;
    const ta = host.querySelector("textarea"), hl = host.querySelector(".ed-hl"), gn = host.querySelector(".ed-gn");
    const gcl = host.querySelector(".ed-gcl"), cl = host.querySelector(".ed-cl"), bms = host.querySelectorAll(".ed-bm");
    const PAD_T = 10, PAD_L = 12;
    let charW = 8, lh = 21, lines = 0, escapeNext = false, raf = 0, dirtyText = true, flashT = 0;

    function measure() {
      const fs = parseFloat(getComputedStyle(ta).fontSize) || 13.5;
      lh = Math.round(fs * 1.6);
      host.style.setProperty("--lh", lh + "px");
      const probe = document.createElement("span");
      probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font:inherit;left:0;top:0";
      probe.textContent = "M".repeat(60);
      ta.parentNode.appendChild(probe);
      charW = probe.getBoundingClientRect().width / 60 || 8;
      probe.remove();
      dirtyText = true; lines = 0; schedule();
    }

    function schedule() { if (!raf) raf = requestAnimationFrame(frame); }

    function lineColOf(v, pos) {
      let line = 0, i = -1;
      while ((i = v.indexOf("\n", i + 1)) !== -1 && i < pos) line++;
      return { line, col: pos - (v.lastIndexOf("\n", pos - 1) + 1) };
    }

    function frame() {
      raf = 0;
      const v = ta.value;
      if (dirtyText) {
        dirtyText = false;
        hl.innerHTML = highlight(v, lang) + "\n";
        let n = 1, i = -1; while ((i = v.indexOf("\n", i + 1)) !== -1) n++;
        if (n !== lines) {
          lines = n;
          let s = "1"; for (let k = 2; k <= n; k++) s += "\n" + k;
          gn.textContent = s;
          host.style.setProperty("--gw", Math.max(3, String(n).length) * charW + 24 + "px");
        }
      }
      const st = ta.scrollTop, sl = ta.scrollLeft;
      hl.style.transform = `translate(${-sl}px,${-st}px)`;
      gn.style.transform = `translateY(${-st}px)`;
      const s = ta.selectionStart, e = ta.selectionEnd, pos = lineColOf(v, e === s ? s : ta.selectionDirection === "backward" ? s : e);
      const y = PAD_T + pos.line * lh - st;
      cl.style.transform = `translateY(${y}px)`; cl.style.height = lh + "px";
      gcl.style.transform = `translateY(${y}px)`; gcl.style.height = lh + "px";
      cl.style.opacity = gcl.style.opacity = s === e ? "1" : "0.5";
      // matching brackets
      const m = s === e && v.length < 400000 ? findMatch(v, s, lang) : null;
      if (m) {
        m.forEach((idx, k) => {
          const p = lineColOf(v, idx), ls = lineStartOf(v, idx);
          const x = PAD_L + vcol(v.slice(ls, idx)) * charW - sl, yy = PAD_T + p.line * lh - st;
          bms[k].style.cssText = `display:block;width:${charW}px;height:${lh}px;transform:translate(${x}px,${yy}px)`;
        });
      } else bms.forEach((b) => (b.style.display = "none"));
      if (opt.onCursor) {
        const a = lineColOf(v, s);
        opt.onCursor(a.line + 1, vcol(v.slice(lineStartOf(v, s), s)) + 1, e - s, lines || 1);
      }
    }

    function apply(ed) {
      ta.focus();
      const { from, to, insert } = ed;
      if (!(from === to && insert === "")) {
        ta.setSelectionRange(from, to);
        let ok = false;
        try { ok = insert === "" ? document.execCommand("delete") : document.execCommand("insertText", false, insert); } catch (_) { ok = false; }
        if (!ok) { ta.setRangeText(insert, from, to, "end"); ta.dispatchEvent(new Event("input", { bubbles: true })); }
      }
      const ss = ed.selStart !== undefined ? ed.selStart : from + insert.length;
      ta.setSelectionRange(ss, ed.selEnd !== undefined ? ed.selEnd : ss);
      schedule();
    }

    ta.addEventListener("keydown", (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      const mod = e.ctrlKey || e.metaKey, v = ta.value, s = ta.selectionStart, en = ta.selectionEnd;
      if (mod && e.key === "Enter") {
        e.preventDefault(); e.stopPropagation();
        if (e.shiftKey) opt.onSubmit && opt.onSubmit(); else opt.onRun && opt.onRun();
        return;
      }
      if (mod && !e.altKey && !e.shiftKey && (e.key === "/" || e.code === "Slash")) { e.preventDefault(); apply(toggleComment(v, s, en, lang)); return; }
      if (e.key === "Escape") { escapeNext = true; return; }
      if (e.key === "Tab" && !mod && !e.altKey) {
        if (escapeNext) { escapeNext = false; return; }           // Esc, then Tab leaves the editor
        e.preventDefault(); apply(tabEdit(v, s, en, e.shiftKey)); return;
      }
      if (e.key !== "Shift" && e.key !== "Control" && e.key !== "Alt" && e.key !== "Meta") escapeNext = false;
      if (mod || e.altKey) return;
      if (e.key === "Enter") { e.preventDefault(); apply(onEnter(v, s, en, lang)); return; }
      if (e.key === "Backspace") { const ed = onBackspace(v, s, en, lang); if (ed) { e.preventDefault(); apply(ed); } return; }
      if (e.key.length === 1) { const ed = onChar(v, s, en, e.key, lang); if (ed) { e.preventDefault(); apply(ed); } }
    });
    ta.addEventListener("blur", () => { escapeNext = false; });
    ta.addEventListener("input", () => { dirtyText = true; schedule(); opt.onChange && opt.onChange(); });
    ta.addEventListener("scroll", schedule, { passive: true });
    ["keyup", "mouseup", "focus", "click"].forEach((ev) => ta.addEventListener(ev, schedule));
    const onSel = () => { if (document.activeElement === ta) schedule(); };
    document.addEventListener("selectionchange", onSel);
    let ro = null;
    if (window.ResizeObserver) { ro = new ResizeObserver(schedule); ro.observe(host); }

    measure();
    return {
      el: ta,
      getValue: () => ta.value,
      /** Replace everything (clears the undo stack). */
      setValue(v) { ta.value = v; ta.scrollTop = ta.scrollLeft = 0; ta.setSelectionRange(0, 0); dirtyText = true; schedule(); },
      /** Replace everything but keep Ctrl+Z working. */
      replaceAll(v) { ta.focus(); ta.setSelectionRange(0, ta.value.length); apply({ from: 0, to: ta.value.length, insert: v, selStart: v.length, selEnd: v.length }); ta.scrollTop = ta.scrollLeft = 0; },
      setLang(l) { lang = l; dirtyText = true; schedule(); },
      focus() { ta.focus(); },
      refreshFont() { measure(); },
      goto(line, col) {
        const v = ta.value; let idx = 0;
        for (let k = 1; k < line; k++) { const nl = v.indexOf("\n", idx); if (nl < 0) break; idx = nl + 1; }
        const le = lineEndOf(v, idx);
        idx = Math.min(le, idx + Math.max(0, (col || 1) - 1));
        ta.focus(); ta.setSelectionRange(idx, idx);
        const target = (line - 1) * lh - ta.clientHeight / 2 + lh;
        ta.scrollTop = Math.max(0, target);
        cl.classList.add("flash"); clearTimeout(flashT); flashT = setTimeout(() => cl.classList.remove("flash"), 1400);
        schedule();
      },
      destroy() { document.removeEventListener("selectionchange", onSel); if (ro) ro.disconnect(); cancelAnimationFrame(raf); },
    };
  }

  return { mount, core };
});
