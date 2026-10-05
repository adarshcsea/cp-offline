(async () => {
  const { $, $$, esc, api, toast, platformBadge, levelBadge, statusBadge, fmtText, overlay, ago, clock, on } = CP;
  const q = new URLSearchParams(location.search);
  const paras = (t) => String(t).split(/\n{2,}/).map((x) => `<p>${fmtText(x)}</p>`).join("");
  const id = q.get("id"), contestId = q.get("contest");
  const root = $("#root");
  const fail = (m) => { root.innerHTML = `<div class="card errbox">${esc(m)}<div class="mt"><a class="btn" href="/problems.html">Back to problems</a></div></div>`; };
  if (!id) return fail("No problem specified.");
  let p;
  try { p = await api("/api/problems/" + encodeURIComponent(id)); } catch (e) { return fail(e.message); }
  document.title = `${p.title} · CP Offline`;

  const isLC = p.platform === "leetcode";
  let lang = "python", busy = false, lastRun = null;
  try { lang = localStorage.getItem("cp-offline-lang") || p.language || "python"; } catch { lang = p.language || "python"; }
  if (!["python", "cpp"].includes(lang)) lang = "python";
  const key = (l) => `cp-offline-${p.id}:${l}`;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* quota/private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  /* ---------------- templates ---------------- */
  function lcArgNames() {
    const t = (p.examples[0] && p.examples[0].example_text) || "";
    const line = (t.split("Input:")[1] || "").split("Output:")[0];
    const names = []; const re = /(?:^|[\s,])([A-Za-z_]\w*)\s*=/g; let m;
    while ((m = re.exec(line))) if (!names.includes(m[1])) names.push(m[1]);
    return names;
  }
  function template(l) {
    if (isLC) {
      if (l === "python") return `from typing import List, Optional\n\n# ListNode and TreeNode are provided by the local runner.\n# Name the method as on LeetCode; the first public method of Solution is called.\nclass Solution:\n    def solve(self${lcArgNames().map((n) => ", " + n).join("")}):\n        pass\n`;
      return `// LeetCode-style problems have no stdin format, so examples cannot be auto-tested in C++.\n// You can still compile and run with Custom Input.\n#include <bits/stdc++.h>\nusing namespace std;\n\nclass Solution {\npublic:\n    // TODO\n};\n\nint main() {\n    ios::sync_with_stdio(false);\n    cin.tie(nullptr);\n    return 0;\n}\n`;
    }
    if (l === "python") return `import sys\n\n\ndef main():\n    data = sys.stdin.read().split()\n    # TODO\n\n\nmain()\n`;
    return `#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    ios::sync_with_stdio(false);\n    cin.tie(nullptr);\n\n    // TODO\n    return 0;\n}\n`;
  }

  /* ---------------- layout ---------------- */
  const levelTxt = p.platform === "codeforces" ? (p.rating ? `Rating ${p.rating}` : "Unrated") : p.tier;
  root.innerHTML = `
  <div class="row mb" style="align-items:flex-start;justify-content:space-between">
    <div class="grow" style="min-width:260px">
      <div class="meta">${platformBadge(p.platform)}<span class="badge mono">${esc(CP.shortId(p.id))}</span>${levelBadge(p)}<span id="status-badge">${statusBadge(p.status)}</span>
        <span class="faint" id="attempts-info"></span>
        ${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer" class="badge">Source ↗</a>` : ""}</div>
      <h1 class="ptitle-h" style="margin:0">${esc(p.title)}</h1>
      ${p.tags.length ? `<div class="tags mt">${p.tags.map((t) => `<a class="tag" href="/problems.html?platform=${p.platform}&tag=${encodeURIComponent(t.toLowerCase())}">${esc(t)}</a>`).join("")}</div>` : ""}
    </div>
    <div class="row" id="progress-actions">
      <button class="btn good" data-status="solved">✓ Mark Solved</button>
      <button class="btn warn" data-status="review">⟳ Mark Review</button>
      <button class="btn" data-status="attempted">Mark Attempted</button>
    </div>
  </div>
  <div class="ide" id="ide">
    <section class="pane pane-stmt">
      <div class="pane-tabs" role="tablist"><button class="on" data-tab="statement">Statement</button><button data-tab="notes">My Notes</button><button data-tab="history">Submissions <span class="faint" id="sub-count">${p.submission_count || ""}</span></button></div>
      <div class="pane-body scroll" id="tab-statement"></div>
      <div class="pane-body scroll hidden" id="tab-notes"></div>
      <div class="pane-body scroll hidden" id="tab-history"></div>
    </section>
    <section class="pane pane-code">
      <div class="toolbar">
        <select id="lang" aria-label="Language"><option value="python">Python 3</option><option value="cpp">C++17</option></select>
        <button class="btn primary" id="run" title="Run the statement examples (Ctrl+Enter)">▶ Run<kbd>Ctrl+↵</kbd></button>
        <button class="btn" id="submit" title="Run the examples and record the attempt in your history (Ctrl+Shift+Enter)">Submit<kbd>Ctrl+Shift+↵</kbd></button>
        <button class="btn" id="custom-toggle" title="Test your own input">Custom Input</button>
        <span class="grow"></span>
        <span class="save-state" id="save-state"></span>
        <button class="btn sm hidden" id="restore" title="Replace the editor with your last explicitly saved version (Ctrl+Z undoes this)">Restore saved</button>
        <button class="btn sm" id="save" title="Ctrl+S">Save</button>
        <button class="btn sm" id="clear" title="Empty the editor (Ctrl+Z undoes this)">Clear</button>
        <button class="btn sm" id="reset-code">Reset</button>
      </div>
      <div id="editor-host"></div>
      <div class="ed-status"><span id="ed-pos">Ln 1, Col 1</span><span>Spaces: 4</span><span id="ed-lang"></span><span class="grow"></span><span class="hint">Ctrl+/ comment · Esc, then Tab leaves the editor</span></div>
    </section>
    <section class="outpanel collapsed" id="outpanel" aria-label="Results">
      <div class="op-resize" id="op-resize" title="Drag to resize"></div>
      <div class="op-head">
        <div class="op-tabs" role="tablist">
          <button data-op="tests" class="on">Tests <span class="op-badge" id="b-tests"></span></button>
          <button data-op="output">Output</button>
          <button data-op="errors">Errors <span class="op-badge" id="b-errors"></span></button>
          <button data-op="submission">Submission</button>
          <button data-op="custom">Custom Input</button>
        </div>
        <span id="verdict"></span><span class="faint mono" id="run-meta" style="font-size:12px"></span>
        <span class="grow"></span>
        <button class="btn sm" id="op-max" title="Maximize / restore the results panel">⤢</button>
        <button class="btn sm" id="op-toggle" title="Show / hide the results panel" aria-label="Toggle results panel">▾</button>
      </div>
      <div class="op-body">
        <div class="op-pane" id="op-tests"></div>
        <div class="op-pane hidden" id="op-output"></div>
        <div class="op-pane hidden" id="op-errors"></div>
        <div class="op-pane hidden" id="op-submission"></div>
        <div class="op-pane hidden" id="op-custom">
          <div class="cust">
            <div class="cust-in">
              <div class="row" style="gap:8px"><span class="blk-l">Custom input (stdin)</span><span class="grow"></span>
                ${!isLC && p.examples.length ? `<select id="ex-pick" aria-label="Load an example"><option value="">Load example…</option>${p.examples.map((_, i) => `<option value="${i}">Example ${i + 1}</option>`).join("")}</select>` : ""}
                <button class="blk-b" data-act="clear-custom">Clear</button></div>
              <textarea id="stdin" spellcheck="false" placeholder="5&#10;1 2 3 4 5" aria-label="Custom input"></textarea>
              <div class="row"><button class="btn primary" id="run-custom">▶ Run Custom Test</button><span class="faint" style="font-size:12px">Ctrl+Enter while typing here runs it</span></div>
            </div>
            <div class="cust-out" id="custom-out"></div>
          </div>
        </div>
      </div>
    </section>
  </div>`;

  /* ---------------- statement ---------------- */
  function sampleBlock(n, input, output) {
    return `<div class="sample"><div class="sh"><span>Example ${n}</span><span><button class="copy" data-use="${n - 1}">use as custom input</button></span></div>
      <div class="sp"><div class="sh" style="background:none;padding-bottom:0">Input <button class="copy" data-copy="in-${n - 1}">copy</button></div><pre id="in-${n - 1}">${esc(input)}</pre></div>
      <div class="sp"><div class="sh" style="background:none;padding-bottom:0">Output <button class="copy" data-copy="out-${n - 1}">copy</button></div><pre id="out-${n - 1}">${esc(output)}</pre></div></div>`;
  }
  function renderStatement() {
    let html = "";
    if (isLC) {
      let text = p.statement || "";
      const ci = text.indexOf("Constraints:");
      const constraints = ci >= 0 ? text.slice(ci + 12).trim() : "";
      text = (ci >= 0 ? text.slice(0, ci) : text).replace(/^Example \d+:\s*$/gm, "").trim();
      html += text ? paras(text) : `<p class="faint">Statement text is not available offline.</p>`;
      if (p.examples.length) {
        html += `<h3>Examples</h3>` + p.examples.map((e, i) => {
          const t = String(e.example_text || "");
          const [inp, rest] = t.includes("Output:") ? [t.split("Output:")[0].replace(/^\s*Input:\s*/, ""), t.split("Output:").slice(1).join("Output:")] : [t, ""];
          const [out, expl] = rest.split(/\n\s*Explanation:?/);
          return `<div class="sample"><div class="sh"><span>Example ${i + 1}</span></div>
            <div class="sp"><div class="sh" style="background:none;padding-bottom:0">Input</div><pre>${esc(inp.trim())}</pre></div>
            ${rest ? `<div class="sp"><div class="sh" style="background:none;padding-bottom:0">Output</div><pre>${esc((out || "").trim())}</pre></div>` : ""}
            ${expl ? `<div class="sp"><div class="sh" style="background:none;padding-bottom:0">Explanation</div><pre>${esc(expl.trim())}</pre></div>` : ""}</div>`;
        }).join("");
      }
      html += `<h3>Constraints</h3>` + (constraints ? `<p>${fmtText(constraints)}</p>` : `<p class="faint">Constraints are not stored for this problem in the offline dataset${p.url ? " - see the source link" : ""}.</p>`);
    } else {
      if (!p.statement) {
        html += `<div class="empty" style="padding:24px 0;text-align:left"><b>Statement not available offline.</b><br>This problem's text was not imported into the database.${p.url ? ` <a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">Open on Codeforces ↗</a>` : ""}</div>`;
      } else html += paras(p.statement);
      if (p.input_format) html += `<h3>Input</h3>${paras(p.input_format)}`;
      if (p.output_format) html += `<h3>Output</h3>${paras(p.output_format)}`;
      html += `<h3>Examples</h3>` + (p.examples.length ? p.examples.map((e, i) => sampleBlock(i + 1, e.input ?? "", e.output ?? "")).join("") : `<p class="faint">No examples stored for this problem, so Run Examples is unavailable. Use Custom Input.</p>`);
    }
    $("#tab-statement").innerHTML = `<div class="stmt">${html}</div>`;
  }
  renderStatement();

  /* ---------------- progress ---------------- */
  function showProgress(s, attempts) {
    p.status = s; $("#status-badge").innerHTML = statusBadge(s);
    if (attempts !== undefined) p.attempts = attempts;
    $("#attempts-info").textContent = p.attempts ? `${p.attempts} attempt${p.attempts === 1 ? "" : "s"}` : "";
    $$("#progress-actions [data-status]").forEach((b) => b.classList.toggle("on", b.dataset.status === s));
  }
  showProgress(p.status);
  $("#progress-actions").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-status]"); if (!b) return;
    b.disabled = true;
    try { const r = await api("/api/progress", { problem_id: p.id, status: b.dataset.status }); showProgress(r.status, r.attempts); toast("Marked " + CP.STATUS_LABEL[r.status].toLowerCase(), "ok"); }
    catch (err) { toast(err.message, "err"); } finally { b.disabled = false; }
  });

  /* ---------------- editor ---------------- */
  // Two copies per language: the autosaved DRAFT (key(), the pre-existing localStorage key, so old drafts keep
  // working) and the explicitly SAVED copy (Ctrl+S). Submitting, clearing or resetting never overwrites the saved copy.
  const savedKey = (l) => `cp-offline-${p.id}:${l}:saved`;
  let baseline = "";
  const ed = CPEditor.mount($("#editor-host"), {
    lang,
    onChange: () => { updateSaveState(); autosave(); },
    onRun: () => execute("examples"), onSubmit: () => execute("submit"),
    onCursor: (ln, col, sel, total) => {
      const t = `Ln ${ln}, Col ${col}${sel ? ` (${sel} selected)` : ""} · ${total} line${total === 1 ? "" : "s"}`;
      const el = $("#ed-pos"); if (el && el.textContent !== t) el.textContent = t;
    },
  });
  const code = ed.el;
  function updateSaveState() {
    const dirty = code.value !== baseline, el = $("#save-state");
    el.textContent = dirty ? "● Unsaved changes (draft kept)" : "✓ Saved";
    el.className = "save-state " + (dirty ? "dirty" : "ok");
    $("#restore").classList.toggle("hidden", !(dirty && store.get(savedKey(lang)) !== null));
    $("#ed-lang").textContent = lang === "cpp" ? "C++17" : "Python 3";
  }
  function loadCode() {
    const draft = store.get(key(lang)), saved = store.get(savedKey(lang));
    const v = draft !== null ? draft : saved !== null ? saved : template(lang);
    baseline = saved !== null ? saved : v;               // a legacy draft with no explicit save counts as saved
    ed.setLang(lang); ed.setValue(v); updateSaveState();
  }
  const persist = () => store.set(key(lang), code.value);
  const autosave = CP.debounce(persist, 400);
  window.addEventListener("pagehide", persist);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") persist(); });
  $("#lang").value = lang;
  $("#lang").addEventListener("change", () => { persist(); lang = $("#lang").value; store.set("cp-offline-lang", lang); loadCode(); resetResults(); });
  loadCode();
  function saveNow() { persist(); store.set(savedKey(lang), code.value); baseline = code.value; updateSaveState(); toast("Saved", "ok"); }
  $("#save").onclick = saveNow;
  $("#clear").onclick = () => { ed.replaceAll(""); persist(); updateSaveState(); ed.focus(); };
  $("#restore").onclick = () => { const s = store.get(savedKey(lang)); if (s !== null) { ed.replaceAll(s); persist(); updateSaveState(); toast("Restored saved version (Ctrl+Z to undo)"); } };
  $("#reset-code").onclick = () => {
    overlay("confirm", `<div class="modal-head"><h2>Reset code?</h2></div><p class="muted">This replaces the editor with the ${lang === "cpp" ? "C++17" : "Python"} starter template. Your explicitly saved copy and submission history are kept, and Ctrl+Z still undoes it.</p>
      <div class="row" style="justify-content:flex-end"><button class="btn" data-close>Cancel</button><button class="btn danger" id="confirm-reset">Reset</button></div>`);
    $("#confirm-reset").onclick = () => { ed.replaceAll(template(lang)); persist(); updateSaveState(); CP.closeOverlays(); toast("Code reset"); ed.focus(); };
  };
  document.addEventListener("click", (e) => { if (e.target.closest("#fs-dec,#fs-inc")) setTimeout(() => ed.refreshFont(), 40); });

  /* ---------------- IDE sizing ---------------- */
  const ide = $("#ide");
  function fitIde() {
    if (window.innerWidth <= 1000) { ide.style.removeProperty("--ide-h"); return; }
    const top = ide.getBoundingClientRect().top + window.scrollY;
    ide.style.setProperty("--ide-h", Math.max(690, window.innerHeight - top - 14) + "px");
  }
  fitIde(); window.addEventListener("resize", CP.debounce(fitIde, 120));
  const panel = $("#outpanel");
  try { const h = parseInt(localStorage.getItem("cp-offline-oph"), 10); if (h >= 120) panel.style.setProperty("--op-h", h + "px"); } catch { /* ignore */ }
  $("#op-resize").addEventListener("pointerdown", (e) => {
    e.preventDefault(); const h0 = panel.getBoundingClientRect().height, y0 = e.clientY, el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const mv = (m) => panel.style.setProperty("--op-h", Math.round(Math.min(window.innerHeight * 0.8, Math.max(120, h0 + (y0 - m.clientY)))) + "px");
    const up = () => { el.removeEventListener("pointermove", mv); el.removeEventListener("pointerup", up); store.set("cp-offline-oph", parseInt(panel.style.getPropertyValue("--op-h"), 10) || 0); };
    el.addEventListener("pointermove", mv); el.addEventListener("pointerup", up);
  });
  $("#op-toggle").onclick = () => { panel.classList.toggle("collapsed"); panel.classList.remove("maxed"); $("#op-toggle").textContent = panel.classList.contains("collapsed") ? "▴" : "▾"; };
  $("#op-max").onclick = () => { panel.classList.remove("collapsed"); panel.classList.toggle("maxed"); $("#op-toggle").textContent = "▾"; };
  on("escape", () => panel.classList.remove("maxed"));

  /* ---------------- output helpers ---------------- */
  const VLABEL = { PASS: "Passed", OK: "Finished", "WRONG ANSWER": "Wrong Answer", "COMPILE ERROR": "Compilation Error", "RUNTIME ERROR": "Runtime Error",
    "TIME LIMIT EXCEEDED": "Time Limit Exceeded", "MEMORY LIMIT EXCEEDED": "Memory Limit Exceeded", UNSUPPORTED: "Unsupported", "NO EXAMPLES": "No Examples",
    SKIPPED: "Skipped", ERROR: "Error", "INTERNAL ERROR": "Internal Error" };
  const vcls = (v) => "v-" + String(v).replace(/\s+/g, "-");
  const vpill = (v) => `<span class="verdict ${vcls(v)}">${esc(VLABEL[v] || v)}</span>`;
  const ERR_VERDICTS = ["RUNTIME ERROR", "TIME LIMIT EXCEEDED", "MEMORY LIMIT EXCEEDED"];
  const PREVIEW_LINES = 400, PREVIEW_CHARS = 30000;
  const FULL = new Map(), paneIds = {}; let curPane = "", blkSeq = 0;
  function paneStart(name) { (paneIds[name] || []).forEach((id) => FULL.delete(id)); paneIds[name] = []; curPane = name; }
  const fmtBytes = (n) => (n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(2) + " MB");
  const countLines = (s) => { if (!s) return 0; let n = 1, i = -1; while ((i = s.indexOf("\n", i + 1)) !== -1) n++; return s.endsWith("\n") ? n - 1 : n; };
  function previewOf(text) {
    if (text.length <= PREVIEW_CHARS && countLines(text) <= PREVIEW_LINES) return { text, cut: false };
    let end = Math.min(text.length, PREVIEW_CHARS), nl = 0;
    for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10 && ++nl >= PREVIEW_LINES) { end = i; break; }
    return { text: text.slice(0, end), cut: true };
  }
  const lineSpans = (text, marks, cls, linkify) => text.replace(/\n$/, "").split("\n").map((l, i) => {
    let h = esc(l);
    let c = marks && marks.has(i) ? " " + cls : "";
    if (linkify) {
      h = h.replace(/\b((?:main|solution)\.(?:cpp|py)):(\d+)(?::(\d+))?/g, (m, f, ln, col) => `<a class="errln" data-line="${ln}" data-col="${col || 1}" title="Go to line ${ln}">${m}</a>`)
        .replace(/(File &quot;(?:main|solution)\.py&quot;, line )(\d+)/g, (m, a, ln) => `<a class="errln" data-line="${ln}" data-col="1" title="Go to line ${ln}">${m}</a>`);
      c += /: (?:fatal )?error:|^\s*(?:\w+\.)*\w*(?:Error|Exception|Exit)\b/.test(l) ? " el-err" : /warning:/.test(l) ? " el-warn" : /note:/.test(l) ? " el-note" : "";
    }
    return `<span class="ln${c}">${h || "\u200b"}</span>`;
  }).join("");
  /** One bounded, scrollable text block with Copy and View Full. `text` is always the COMPLETE text we have. */
  function blk(label, text, o = {}) {
    text = text == null ? "" : String(text);
    const id = curPane + ":" + ++blkSeq; FULL.set(id, { title: label, text, err: !!o.linkify }); (paneIds[curPane] = paneIds[curPane] || []).push(id);
    const pv = previewOf(text), lines = countLines(text);
    const body = !text ? `<span class="faint">(empty)</span>` : o.marks && o.marks.size || o.linkify ? lineSpans(pv.text, o.marks, o.markCls, o.linkify) : esc(pv.text);
    const meta = text ? `${lines.toLocaleString()} line${lines === 1 ? "" : "s"} · ${fmtBytes(o.bytes != null ? o.bytes : text.length)}` : "";
    return `<div class="blk ${o.cls || ""}" data-blk="${id}"><div class="blk-h"><span class="blk-l">${esc(label)}</span><span class="blk-m">${meta}</span><span class="grow"></span>
      <button class="blk-b" data-act="copy">Copy</button><button class="blk-b" data-act="full" title="Open the complete text in a large viewer">⤢ View Full</button></div>
      <pre class="blk-p">${body}</pre>
      ${pv.cut ? `<div class="blk-n">Showing a preview: first ${countLines(pv.text).toLocaleString()} of ${lines.toLocaleString()} lines. <button data-act="full">View Full Output</button></div>` : ""}
      ${o.runnerCut ? `<div class="blk-n">The runner kept only the first ${fmtBytes(text.length)} of the ${fmtBytes(o.runnerCut)} the program wrote. Print less to see the rest.</div>` : ""}</div>`;
  }
  const clip = (s, n = 70) => { s = String(s ?? ""); return JSON.stringify(s.length > n ? s.slice(0, n) + "…" : s); };
  function diffInfo(expected, actual) {
    const norm = (l) => l.trim().split(/\s+/).filter(Boolean).join(" ");
    const e = String(expected).replace(/\r/g, "").replace(/\n+$/, "").split("\n"), a = String(actual).replace(/\r/g, "").replace(/\n+$/, "").split("\n");
    const em = new Set(), am = new Set(); let first = -1;
    for (let i = 0, n = Math.max(e.length, a.length); i < n; i++) {
      if (norm(e[i] ?? "") !== norm(a[i] ?? "")) { if (first < 0) first = i; if (i < e.length) em.add(i); if (i < a.length) am.add(i); if (em.size > 500 && am.size > 500) break; }
    }
    return { first, em, am, e, a };
  }
  function diffMessage(d, actual) {
    if (d.first < 0) return "";
    if (!String(actual).trim()) return "Your program printed nothing.";
    if (d.first >= d.a.length) return `Your output stops after line ${d.a.length}, but ${d.e.length} line${d.e.length === 1 ? " is" : "s are"} expected.`;
    if (d.first >= d.e.length) return `Extra output from line ${d.first + 1} on (expected only ${d.e.length} line${d.e.length === 1 ? "" : "s"}).`;
    return `First difference at line ${d.first + 1}: expected ${clip(d.e[d.first])}, got ${clip(d.a[d.first])}.`;
  }
  const chip = (t) => `<span class="chip">${esc(t)}</span>`;
  function statusChips(x) {
    const c = [chip((x.runtime_ms ?? 0) + " ms")];
    if (x.exit_code !== null && x.exit_code !== undefined) c.push(chip("exit code " + x.exit_code));
    if (x.signal) c.push(chip("signal " + x.signal));
    return `<span class="chips">${c.join("")}</span>`;
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
    const t = document.createElement("textarea"); t.value = text; t.style.cssText = "position:fixed;opacity:0"; document.body.append(t); t.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch { /* ignore */ } t.remove(); return ok;
  }
  function openFull(entry) {
    const lines = countLines(entry.text);
    overlay("fullview", `<div class="modal-head"><h2>${esc(entry.title)}</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>
      <div class="fv-bar"><span class="chip">${lines.toLocaleString()} lines · ${fmtBytes(entry.text.length)}</span><label><input type="checkbox" id="fv-wrap"> Wrap long lines</label><span class="grow"></span>
      <button class="btn sm" id="fv-copy">Copy all</button><button class="btn sm" id="fv-dl">Download .txt</button></div>
      <pre class="fv" id="fv-pre" tabindex="0"></pre>`, "xl");
    const pre = $("#fv-pre"); if (entry.err) pre.innerHTML = lineSpans(entry.text, null, "", true); else pre.textContent = entry.text;
    $("#fv-wrap").onchange = (e) => pre.classList.toggle("wrap", e.target.checked);
    $("#fv-copy").onclick = async () => toast((await copyText(entry.text)) ? "Copied" : "Copy failed - select the text and press Ctrl+C", "ok");
    $("#fv-dl").onclick = () => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([entry.text], { type: "text/plain" })); a.download = entry.title.replace(/\W+/g, "_").toLowerCase() + ".txt"; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
    pre.focus();
  }

  /* ---------------- results state + rendering ---------------- */
  const state = { run: null, sub: null, custom: null, last: null, sel: 0, pending: null, internal: null, tab: "tests" };
  const running = (label, t) => `<div class="op-running"><span class="dotp"></span>${esc(label)}<span class="faint mono" data-elapsed>${t || ""}</span></div>`;
  function testIcon(v) { return v === "PASS" ? ["✓", "pass"] : v === "UNSUPPORTED" || v === "SKIPPED" || v === "NO EXAMPLES" ? ["–", "skip"] : ["✗", "fail"]; }
  function errBanner(t) {
    return `<div class="banner bad"><b>${esc(t.error_title || VLABEL[t.verdict] || t.verdict)}</b>${t.error_detail ? " - " + esc(t.error_detail) : ""}
      ${t.stderr ? ` <button class="linkish" data-op-go="errors">Open in Errors tab</button>` : ""}</div>`;
  }
  function testDetail(t) {
    const pass = t.verdict === "PASS";
    let h = `<div class="thead"><h3>Test Case ${t.n}</h3>${vpill(t.verdict)}${statusChips(t)}</div>`;
    if (pass) h += `<div class="banner good">✓ Passed${t.note ? " - " + esc(t.note) : ""}</div>`;
    else if (t.verdict === "WRONG ANSWER") h += "";                      // filled below with the diff message
    else if (t.verdict === "UNSUPPORTED" || t.verdict === "SKIPPED") h += `<div class="banner warn">${esc(t.note || "")}</div>`;
    else h += errBanner(t);
    let d = null;
    if (t.verdict === "WRONG ANSWER") {
      d = diffInfo(t.expected ?? "", t.actual ?? "");
      h += `<div class="banner bad"><b>✗ Failed - Wrong Answer.</b> ${esc(diffMessage(d, t.actual ?? "")) || "The output differs from the expected output."}${t.note ? " " + esc(t.note) : ""}</div>`;
    }
    h += blk("Input", t.input, { bytes: t.input_bytes });
    if (t.expected !== undefined && t.verdict !== "UNSUPPORTED") {
      h += `<div class="blk-grid">${blk("Expected Output", t.expected, d ? { marks: d.em, markCls: "dl-e" } : {})}
        ${blk("Your Output", t.actual ?? "", { marks: d ? d.am : null, markCls: "dl-a", bytes: t.actual_bytes, runnerCut: t.actual_truncated ? t.actual_bytes : 0 })}</div>`;
    }
    if (t.stdout) h += blk("Printed (stdout)", t.stdout);
    if (t.stderr) h += blk("Stderr", t.stderr, { linkify: true, cls: "err", bytes: t.stderr_bytes, runnerCut: t.stderr_truncated ? t.stderr_bytes : 0 });
    return h;
  }
  function renderTests() {
    paneStart("tests"); const host = $("#op-tests"), r = state.run;
    if (state.pending === "examples" || state.pending === "submit") { host.innerHTML = running(state.pending === "submit" ? "Submitting…" : lang === "cpp" ? "Compiling and running…" : "Running…"); return; }
    if (!r) { host.innerHTML = `<div class="op-empty">Press <b>Run</b> (Ctrl+Enter) to try the statement examples. Each test shows its input, the expected output and yours.</div>`; return; }
    if (r.verdict === "COMPILE ERROR") {
      host.innerHTML = `<div class="banner bad"><b>${esc(r.error_title || "Compilation Error")}</b> - nothing was executed. Click an error line to jump to it in the editor.</div><div class="mt">${blk("Compiler output", r.compile_output || r.output, { linkify: true, cls: "err" })}</div>`;
      return;
    }
    if (!r.tests || !r.tests.length) { host.innerHTML = `<div class="banner ${r.verdict === "ERROR" ? "bad" : "warn"}">${esc(r.output || r.error || "No tests were run.")}</div>`; return; }
    state.sel = Math.min(state.sel, r.tests.length - 1);
    const list = r.tests.map((t, i) => { const [ic, cl] = testIcon(t.verdict); return `<button class="titem ${i === state.sel ? "on" : ""}" data-t="${i}"><span class="ic ${cl}">${ic}</span>Test ${t.n}<span class="ms">${t.runtime_ms ?? 0} ms</span></button>`; }).join("");
    host.innerHTML = `<div class="tests-wrap"><div class="tlist">${list}</div><div class="tdetail">${testDetail(r.tests[state.sel])}</div></div>${r.notice ? `<div class="banner info mt">${esc(r.notice)}</div>` : ""}`;
  }
  function renderOutput() {
    paneStart("output"); const host = $("#op-output");
    if (state.pending) { host.innerHTML = running("Running…"); return; }
    let x = null, title = "";
    if (state.last === "custom" && state.custom) { x = state.custom; title = "Custom test"; }
    else if (state.run && state.run.tests && state.run.tests.length) { x = state.run.tests[state.sel]; title = "Test " + x.n; }
    else if (state.run && state.run.verdict === "COMPILE ERROR") { host.innerHTML = `<div class="banner bad">Nothing ran: the code did not compile. See the <button class="linkish" data-op-go="errors">Errors tab</button>.</div>`; return; }
    if (!x) { host.innerHTML = `<div class="op-empty">Run something to see the program's stdout and stderr here.</div>`; return; }
    const out = x.stdout !== undefined && x.actual === undefined ? x.stdout : (x.actual ?? x.stdout ?? "");
    const so = x.actual !== undefined && x.stdout ? x.stdout : null;
    host.innerHTML = `<div class="thead"><h3>${esc(title)}</h3>${vpill(x.verdict)}${statusChips(x)}</div>
      ${ERR_VERDICTS.includes(x.verdict) ? `<div class="mt">${errBanner(x)}</div>` : ""}
      <div class="mt">${blk("Stdout", so !== null ? so : out, { bytes: x.stdout_bytes ?? x.actual_bytes, runnerCut: (x.stdout_truncated || x.actual_truncated) ? (x.stdout_bytes ?? x.actual_bytes) : 0 })}</div>
      <div class="mt">${blk("Stderr", x.stderr || "", { linkify: true, bytes: x.stderr_bytes, runnerCut: x.stderr_truncated ? x.stderr_bytes : 0 })}</div>`;
  }
  function collectErrors() {
    const out = [];
    if (state.internal) out.push({ title: "Internal Error", detail: state.internal, text: "" });
    const src = state.last === "custom" ? state.custom : state.run;
    if (!src) return out;
    if (src.verdict === "COMPILE ERROR") out.push({ title: src.error_title || "Compilation Error", detail: "", text: src.compile_output || src.stderr || src.output, label: "Compiler output" });
    else if (src.mode === "custom" && ERR_VERDICTS.includes(src.verdict)) out.push({ title: src.error_title || VLABEL[src.verdict], detail: src.error_detail, text: src.stderr, x: src, label: "Stderr / traceback" });
    (src.tests || []).forEach((t) => { if (ERR_VERDICTS.includes(t.verdict)) out.push({ title: `Test ${t.n}: ${t.error_title || VLABEL[t.verdict]}`, detail: t.error_detail || t.note, text: t.stderr, x: t, label: "Stderr / traceback" }); });
    return out;
  }
  function renderErrors() {
    paneStart("errors"); const host = $("#op-errors"), errs = collectErrors();
    if (state.pending) { host.innerHTML = running("Running…"); return; }
    host.innerHTML = errs.length ? errs.map((e) => `<div class="err-sec"><h3>${esc(e.title)}</h3>${e.detail ? `<div class="banner bad">${esc(e.detail)}</div>` : ""}${e.x ? statusChips(e.x) : ""}
      ${e.text ? blk(e.label || "Details", e.text, { linkify: true, cls: "err", bytes: e.x && e.x.stderr_bytes, runnerCut: e.x && e.x.stderr_truncated ? e.x.stderr_bytes : 0 }) : ""}</div>`).join("")
      : `<div class="op-empty">${state.run || state.custom ? "No errors in the last run. ✓" : "Compiler errors, Python tracebacks, crashes (segfault, exit codes) and timeouts show up here."}</div>`;
    const b = $("#b-errors"); b.textContent = errs.length || ""; b.className = "op-badge" + (errs.length ? " bad" : "");
  }
  function renderSubmission() {
    paneStart("submission"); const host = $("#op-submission"), r = state.sub;
    if (state.pending === "submit") {
      const n = p.examples.length;
      host.innerHTML = `<div class="sub-banner run">Submitting… <small>${n ? `running ${n} example${n === 1 ? "" : "s"}` : ""}</small></div>
        <div class="sub-tests">${Array.from({ length: n }, (_, i) => `<span class="sub-t wait"><span class="ic">…</span>Test ${i + 1}</span>`).join("")}</div>`;
      return;
    }
    if (!r) { host.innerHTML = `<div class="op-empty">Press <b>Submit</b> (Ctrl+Shift+Enter) to run every statement example and record the attempt in your history.</div>`; return; }
    const good = r.verdict === "PASS", sec = ((r.runtime_ms || 0) / 1000).toFixed(2);
    const title = good ? "✓ Samples passed" : "✗ " + (VLABEL[r.verdict] || r.verdict);
    const note = r.verdict === "COMPILE ERROR" ? `<button class="linkish" data-op-go="errors">See the compiler output</button>` : "";
    host.innerHTML = `<div class="sub-banner ${good ? "good" : r.verdict === "UNSUPPORTED" || r.verdict === "NO EXAMPLES" ? "warn" : "bad"}">${esc(title)}
        <small>${r.total ? `Passed: ${r.passed} / ${r.total} · Runtime: ${sec}s` : ""} ${note}</small></div>
      <div class="sub-tests">${(r.tests || []).map((t, i) => { const [ic, cl] = testIcon(t.verdict); return `<button class="sub-t ${cl}" data-subtest="${i}" title="${esc(VLABEL[t.verdict] || t.verdict)}"><span class="ic">${ic}</span>Test ${t.n}${t.verdict !== "PASS" ? ` <span class="faint">${esc(VLABEL[t.verdict] || t.verdict)}</span>` : ""}</button>`; }).join("")}</div>
      ${good ? `<div class="banner info">Only the statement's sample examples are available offline, so this is not a full "Accepted" - hidden tests are not checked.</div>` : ""}
      ${r.submission_id ? `<div class="faint mt" style="font-size:12.5px">Recorded in your submission history as #${r.submission_id}.</div>` : ""}`;
  }
  function renderCustomOut() {
    paneStart("custom"); const host = $("#custom-out"), x = state.custom;
    if (state.pending === "custom") { host.innerHTML = running("Running…"); return; }
    if (!x) { host.innerHTML = `<div class="op-empty">Type some input on the left and press <b>Run Custom Test</b>. The output appears here, using the same runner as the examples.</div>`; return; }
    if (x.verdict === "COMPILE ERROR") { host.innerHTML = `<div class="banner bad"><b>Compilation Error</b> - click a line to jump to it.</div>${blk("Compiler output", x.compile_output || x.output, { linkify: true, cls: "err" })}`; return; }
    if (x.verdict === "ERROR") { host.innerHTML = `<div class="banner bad">${esc(x.output || x.error)}</div>`; return; }
    host.innerHTML = `<div class="thead"><h3>Output</h3>${vpill(x.verdict)}${statusChips(x)}</div>
      ${ERR_VERDICTS.includes(x.verdict) ? errBanner(x) : ""}
      ${blk("Stdout", x.stdout, { bytes: x.stdout_bytes, runnerCut: x.stdout_truncated ? x.stdout_bytes : 0 })}
      ${x.stderr ? blk("Stderr", x.stderr, { linkify: true, cls: "err", bytes: x.stderr_bytes, runnerCut: x.stderr_truncated ? x.stderr_bytes : 0 }) : ""}`;
  }
  function updateBadges() {
    const r = state.run, b = $("#b-tests");
    if (r && r.total) { b.textContent = `${r.passed}/${r.total}`; b.className = "op-badge " + (r.passed === r.total ? "good" : "bad"); } else { b.textContent = ""; b.className = "op-badge"; }
  }
  function renderAll() { renderTests(); renderOutput(); renderErrors(); renderSubmission(); renderCustomOut(); updateBadges(); }
  function showTab(name) {
    state.tab = name; panel.classList.remove("collapsed"); $("#op-toggle").textContent = "▾";
    $$(".op-tabs [data-op]").forEach((b) => b.classList.toggle("on", b.dataset.op === name));
    $$(".op-pane").forEach((x) => x.classList.toggle("hidden", x.id !== "op-" + name));
  }
  function resetResults() { Object.assign(state, { run: null, sub: null, custom: null, last: null, sel: 0, pending: null, internal: null }); $("#verdict").innerHTML = ""; $("#run-meta").textContent = ""; renderAll(); }
  renderAll();

  /* ---------------- running ---------------- */
  let timer = 0;
  async function execute(mode) {
    if (busy) return;
    if (!code.value.trim()) { toast("Write some code first", "err"); return; }
    busy = true; persist();
    const btns = $$("#run,#submit,#run-custom"); btns.forEach((b) => (b.disabled = true));
    state.pending = mode; state.internal = null;
    const t0 = performance.now();
    $("#verdict").innerHTML = `<span class="verdict v-RUNNING">${mode === "submit" ? "SUBMITTING…" : "RUNNING…"}</span>`;
    const tick = () => { const s = ((performance.now() - t0) / 1000).toFixed(1) + "s"; $("#run-meta").textContent = "Running… " + s; $$("[data-elapsed]").forEach((el) => (el.textContent = s)); };
    tick(); timer = setInterval(tick, 200);
    renderAll(); showTab(mode === "custom" ? "custom" : mode === "submit" ? "submission" : "tests");
    let r = null;
    try {
      const body = { problem_id: p.id, language: lang, code: code.value, mode };
      if (mode === "custom") body.stdin = $("#stdin").value;
      if (mode === "submit" && contestId) body.contest_id = Number(contestId);
      r = await api("/api/run", body);
    } catch (e) { state.internal = e.message; }
    clearInterval(timer); state.pending = null;
    if (r) {
      if (mode === "custom") { state.custom = r; state.last = "custom"; }
      else { state.run = r; state.last = "run"; state.sel = Math.max(0, (r.tests || []).findIndex((t) => t.verdict !== "PASS")); if (mode === "submit") state.sub = r; }
      $("#verdict").innerHTML = vpill(r.verdict);
      $("#run-meta").textContent = mode === "custom" ? `${r.runtime_ms ?? 0} ms` : r.total ? `${mode === "submit" ? "SUBMISSION" : "SAMPLE TEST"} · ${r.passed}/${r.total} passed · ${r.runtime_ms ?? 0} ms` : "";
    } else {
      $("#verdict").innerHTML = vpill("INTERNAL ERROR"); $("#run-meta").textContent = "";
    }
    renderAll();
    if (!r) showTab("errors");
    else if (r.verdict === "COMPILE ERROR" && mode !== "custom") showTab("errors");
    try {
      if (r && r.progress) { showProgress(r.progress.status, r.progress.attempts); $("#sub-count").textContent = (Number($("#sub-count").textContent) || 0) + 1; histLoaded = false; }
      if (r && contestId && mode === "submit") { refreshContest(); if (r.verdict === "PASS") toast("Contest problem solved on samples", "ok"); }
    } finally { busy = false; btns.forEach((b) => (b.disabled = false)); }
  }
  $("#run").onclick = () => execute("examples");
  $("#submit").onclick = () => execute("submit");
  $("#run-custom").onclick = () => execute("custom");
  $("#custom-toggle").onclick = () => { showTab("custom"); $("#stdin").focus(); };
  on("run", () => execute("examples")); on("save", () => { saveNow(); if (!$("#tab-notes").classList.contains("hidden")) saveNotes(); });
  // Ctrl+Enter = Run, Ctrl+Shift+Enter = Submit (Ctrl+Enter inside the custom-input box runs the custom test)
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.key !== "Enter" || $(".overlay.open")) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (document.activeElement && document.activeElement.id === "stdin") execute("custom"); else execute(e.shiftKey ? "submit" : "examples");
  }, true);

  /* custom input: remembered per problem */
  const stdinKey = `cp-offline-${p.id}:stdin`, stdinEl = $("#stdin");
  stdinEl.value = store.get(stdinKey) || "";
  stdinEl.addEventListener("input", CP.debounce(() => { if (stdinEl.value.length < 400000) store.set(stdinKey, stdinEl.value); }, 500));
  const pick = $("#ex-pick");
  if (pick) pick.addEventListener("change", () => { if (pick.value !== "") { stdinEl.value = p.examples[+pick.value].input ?? ""; stdinEl.dispatchEvent(new Event("input")); } pick.value = ""; });

  /* clicks: panel tabs, test selection, error links, copy / view full */
  document.addEventListener("click", async (e) => {
    const g = (s) => e.target.closest(s);
    let el;
    if ((el = g("a.errln"))) { e.preventDefault(); CP.closeOverlays(); panel.classList.remove("maxed"); ed.goto(+el.dataset.line, +el.dataset.col); return; }
    if ((el = g("[data-use]"))) { stdinEl.value = p.examples[el.dataset.use].input ?? ""; stdinEl.dispatchEvent(new Event("input")); showTab("custom"); toast("Loaded into custom input"); return; }
    if ((el = g("[data-copy]"))) { if (await copyText($("#" + el.dataset.copy).textContent)) toast("Copied"); return; }
    if (!g("#outpanel") && !g("#fullview")) return;
    if ((el = g("[data-op]"))) return showTab(el.dataset.op);
    if ((el = g("[data-op-go]"))) return showTab(el.dataset.opGo);
    if ((el = g("[data-t]"))) { state.sel = +el.dataset.t; renderTests(); renderOutput(); return; }
    if ((el = g("[data-subtest]"))) { state.sel = +el.dataset.subtest; renderTests(); renderOutput(); showTab("tests"); return; }
    if ((el = g("[data-act]"))) {
      const act = el.dataset.act, b = el.closest("[data-blk]"), entry = b && FULL.get(b.dataset.blk);
      if (act === "copy" && entry) toast((await copyText(entry.text)) ? "Copied" : "Copy failed - select the text and press Ctrl+C", "ok");
      else if (act === "full" && entry) openFull(entry);
      else if (act === "clear-custom") { stdinEl.value = ""; stdinEl.dispatchEvent(new Event("input")); stdinEl.focus(); }
    }
  });

  /* ---------------- tabs, notes, history ---------------- */
  let histLoaded = false, notesLoaded = false;
  $$(".pane-tabs [data-tab]").forEach((b) => b.addEventListener("click", () => {
    $$(".pane-tabs button").forEach((x) => x.classList.toggle("on", x === b));
    ["statement", "notes", "history"].forEach((t) => $("#tab-" + t).classList.toggle("hidden", t !== b.dataset.tab));
    if (b.dataset.tab === "notes" && !notesLoaded) renderNotes();
    if (b.dataset.tab === "history" && !histLoaded) loadHistory();
  }));
  const NOTE_FIELDS = [["observation", "Observation"], ["mistake", "Mistake"], ["key_idea", "Key idea"], ["complexity", "Complexity"], ["need_review", "Need to review"]];
  function renderNotes() {
    notesLoaded = true; const n = p.notes || {};
    $("#tab-notes").innerHTML = `<div class="notes-grid">${NOTE_FIELDS.map(([k, l]) => `<label class="f"><span>${l}</span><textarea data-note="${k}" rows="3">${esc(n[k] || "")}</textarea></label>`).join("")}
      <div class="row"><button class="btn primary" id="save-notes">Save notes</button><span class="faint" id="notes-info">${n.updated_at ? "Saved " + ago(n.updated_at) : "Not saved yet"}</span></div></div>`;
    $("#save-notes").onclick = saveNotes;
  }
  async function saveNotes() {
    if (!notesLoaded) return;
    const body = {}; $$("[data-note]").forEach((t) => (body[t.dataset.note] = t.value));
    try { await api("/api/notes/" + encodeURIComponent(p.id), body); p.notes = { ...body, updated_at: new Date().toISOString() }; $("#notes-info").textContent = "Saved just now"; toast("Notes saved", "ok"); }
    catch (e) { toast(e.message, "err"); }
  }
  async function loadHistory() {
    const host = $("#tab-history"); host.innerHTML = `<div class="loading">Loading…</div>`;
    try {
      const { items } = await api("/api/submissions?problem_id=" + encodeURIComponent(p.id)); histLoaded = true;
      host.innerHTML = items.length ? items.map((s) => `<div class="hist-row" data-sub="${s.id}"><span class="verdict ${vcls(s.result)}">${esc(VLABEL[s.result] || s.result)}</span>
        <span class="mono muted">${s.language === "cpp" ? "C++17" : "Python"}</span><span class="grow"></span><span class="faint mono" style="font-size:12px">${s.passed ?? 0}/${s.total ?? 0} · ${s.runtime_ms ?? 0} ms</span><span class="faint" style="font-size:12px">${ago(s.created_at)}</span></div>`).join("")
        : `<div class="empty">No submissions yet. Use <b>Submit / Test</b> to record an attempt.</div>`;
    } catch (e) { host.innerHTML = `<div class="errbox">${esc(e.message)}</div>`; }
  }
  $("#tab-history").addEventListener("click", async (e) => {
    const row = e.target.closest("[data-sub]"); if (!row) return;
    try {
      const s = await api("/api/submissions/" + row.dataset.sub);
      overlay("sub-overlay", `<div class="modal-head"><h2>Submission #${s.id}</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>
        <div class="meta"><span class="verdict ${vcls(s.result)}">${esc(s.result)}</span><span class="badge">${s.language === "cpp" ? "C++17" : "Python"}</span><span class="badge">${s.passed ?? 0}/${s.total ?? 0} samples</span><span class="badge">${s.runtime_ms ?? 0} ms</span><span class="faint">${new Date(s.created_at).toLocaleString()}</span></div>
        <pre class="code-view">${esc(s.code)}</pre><div class="row mt" style="justify-content:flex-end"><button class="btn primary" id="load-sub">Load into editor</button></div>`, "big");
      $("#load-sub").onclick = () => {
        if (s.language !== lang) { persist(); lang = s.language; $("#lang").value = lang; store.set("cp-offline-lang", lang); loadCode(); resetResults(); }
        ed.replaceAll(s.code); persist(); updateSaveState(); CP.closeOverlays(); toast("Loaded into editor (Ctrl+Z to undo)");
      };
    } catch (err) { toast(err.message, "err"); }
  });

  /* ---------------- contest bar ---------------- */
  let cEnd = 0;
  async function refreshContest() {
    if (!contestId) return;
    try {
      const c = await api("/api/contests/" + encodeURIComponent(contestId));
      cEnd = Date.now() + c.remaining_seconds * 1000;
      $("#contest-bar").innerHTML = `<div class="contest-bar"><i class="dot"></i> ${esc(c.name)} · <span id="c-left" class="mono"></span><span class="grow"></span>
        ${c.problems.map((x) => `<a class="badge ${x.solved ? "s-solved" : ""}" href="/problem.html?id=${encodeURIComponent(x.problem_id)}&contest=${c.id}" style="${x.problem_id === p.id ? "outline:1.5px solid currentColor" : ""}">${x.label}${x.solved ? " ✓" : ""}</a>`).join(" ")}
        <a class="btn sm" href="/contest.html?id=${c.id}">Scoreboard</a></div>`;
    } catch { /* contest bar is optional */ }
  }
  if (contestId) { await refreshContest(); setInterval(() => { const el = $("#c-left"); if (el) el.textContent = cEnd > Date.now() ? clock((cEnd - Date.now()) / 1000) + " left" : "time is up"; }, 1000); }

  /* ---------------- time on problem (real data for "minutes today") ---------------- */
  setInterval(() => { if (document.visibilityState === "visible" && document.hasFocus()) api("/api/time", { problem_id: p.id, seconds: 30 }).catch(() => {}); }, 30000);
})();
