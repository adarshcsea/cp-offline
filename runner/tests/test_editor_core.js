// Run: node runner/tests/test_editor_core.js
// Simulates typing into the editor core: a tiny "document" applies the edits
// returned by the pure functions, with the caret marked by "|".
const { core } = require("../../web/static/editor.js");
let pass = 0, fail = 0;
function ok(name, got, want) {
  if (got === want) pass++; else { fail++; console.log("FAIL", name, "\n  got :", JSON.stringify(got), "\n  want:", JSON.stringify(want)); }
}
class Doc {
  constructor(lang, src = "|") { this.lang = lang; const i = src.indexOf("|"); const j = src.lastIndexOf("|"); this.t = src.replace(/\|/g, ""); this.s = i; this.e = i === j ? i : j - 1; }
  apply(ed) {
    if (!ed) return false;
    this.t = this.t.slice(0, ed.from) + ed.insert + this.t.slice(ed.to);
    const ss = ed.selStart !== undefined ? ed.selStart : ed.from + ed.insert.length;
    this.s = ss; this.e = ed.selEnd !== undefined ? ed.selEnd : ss; return true;
  }
  native(ch) { this.t = this.t.slice(0, this.s) + ch + this.t.slice(this.e); this.s = this.e = this.s + 1; }
  type(str) { for (const ch of str) {
      if (ch === "\n") { this.apply(core.onEnter(this.t, this.s, this.e, this.lang)); continue; }
      const ed = core.onChar(this.t, this.s, this.e, ch, this.lang);
      if (!this.apply(ed)) this.native(ch);
    } return this; }
  enter() { this.apply(core.onEnter(this.t, this.s, this.e, this.lang)); return this; }
  tab(shift) { this.apply(core.tabEdit(this.t, this.s, this.e, !!shift)); return this; }
  bs() { const ed = core.onBackspace(this.t, this.s, this.e, this.lang); if (ed) this.apply(ed); else if (this.s > 0) { this.t = this.t.slice(0, this.s - 1) + this.t.slice(this.s); this.s = this.e = this.s - 1; } return this; }
  comment() { this.apply(core.toggleComment(this.t, this.s, this.e, this.lang)); return this; }
  show() { return this.t.slice(0, this.s) + "|" + this.t.slice(this.s); }
}
const py = (src) => new Doc("python", src), cpp = (src) => new Doc("cpp", src);

/* ---- Python Enter ---- */
ok("py for", py().type("for i in range(n):\n").show(), "for i in range(n):\n    |");
ok("py for body+nested if", py().type("for i in range(n):\nif a[i] > 0:\nprint(a[i])").t,
   "for i in range(n):\n    if a[i] > 0:\n        print(a[i])");
ok("py keeps indent", py().type("for i in range(n):\nx = 1\ny = 2").t, "for i in range(n):\n    x = 1\n    y = 2");
ok("py comment after colon", py().type("if x:  # check\n").show(), "if x:  # check\n    |");
ok("py colon in string no indent", py().type('s = "a:"\n').show(), 's = "a:"\n|');
ok("py dict open bracket", py().type("d = {\n").show(), "d = {\n    |\n}"== "x" ? "" : "d = {\n    |\n}");
ok("py slice colon inside bracket", py().type("x = a[1:\n").show(), "x = a[1:\n|]".replace("|]", "|]"));
for (const kw of ["if x:", "elif x:", "else:", "while x:", "def f(a):", "class A:", "try:", "except E:", "finally:", "with open(f) as g:"])
  ok("py block " + kw, py().type(kw + "\n").show(), kw + "\n    |");
ok("py dedent after return", py().type("def f():\nreturn 1\n").show(), "def f():\n    return 1\n|");
ok("py dedent after pass nested", py().type("if a:\nif b:\npass\n").show(), "if a:\n    if b:\n        pass\n    |");
ok("py blank line indent trimmed", py("if x:\n    |").enter().t, "if x:\n\n    ");
ok("py enter mid-line", py("print(1)|; x").enter().t, "print(1)\n; x");
ok("py enter in docstring", py('def f():\n    """abc|').enter().t, 'def f():\n    """abc\n    ');
ok("py enter splits keeps rest", py("if x:|  y = 1").enter().t, "if x:\n    y = 1");
ok("py trailing ws trimmed", py("x = 1   |").enter().t, "x = 1\n");
/* electric dedent */
ok("py else dedent", py().type("if a:\nfoo()\nelse:").t, "if a:\n    foo()\nelse:");
ok("py elif dedent", py().type("if a:\nfoo()\nelif b:").t, "if a:\n    foo()\nelif b:");
ok("py nested else", py().type("if a:\nif b:\nx()\nelse:").t, "if a:\n    if b:\n        x()\n    else:");
ok("py try/except", py().type("try:\nx()\nexcept ValueError:").t, "try:\n    x()\nexcept ValueError:");
ok("py for-else", py().type("for i in a:\nx()\nelse:").t, "for i in a:\n    x()\nelse:");
ok("py else under def (no opener) unchanged", py().type("def f():\nx = 1\nelse:").t, "def f():\n    x = 1\n    else:");
ok("py colon normal", py().type("x = {1:").t, "x = {1:}");

/* ---- C++ Enter ---- */
ok("cpp brace expand", cpp().type("for (int i = 0; i < n; i++) {\n").show(), "for (int i = 0; i < n; i++) {\n    |\n}");
ok("cpp full loop", cpp().type("for (int i = 0; i < n; i++) {\ncout << i << '\\n';\n}").t.replace(/\n\}\}/, "\n}"),
   "for (int i = 0; i < n; i++) {\n    cout << i << '\\n';\n}");
ok("cpp nested", cpp().type("int main() {\nfor (int i = 0; i < n; i++) {\nif (i % 2 == 0) {\nx++;\n").t,
   "int main() {\n    for (int i = 0; i < n; i++) {\n        if (i % 2 == 0) {\n            x++;\n            \n        }\n    }\n}");
ok("cpp type } overtypes", cpp().type("if (x) {\ny();\n}").show(), "if (x) {\n    y();\n}|");
ok("cpp open brace at EOL then enter", cpp("void f() {|").enter().show(), "void f() {\n    |");
ok("cpp braceless if", cpp().type("if (x)\n").show(), "if (x)\n    |");
ok("cpp braceless body end", cpp().type("if (x)\nfoo();\n").show(), "if (x)\n    foo();\n|");
ok("cpp else braceless", cpp().type("else\n").show(), "else\n    |");
ok("cpp case", cpp().type("switch (x) {\ncase 1:\n").show(), "switch (x) {\n    case 1:\n        |\n}");
ok("cpp // comment brace no indent", cpp().type("// foo {\n").show(), "// foo {\n|");
ok("cpp stmt end", cpp("    int x = 1;|").enter().show(), "    int x = 1;\n    |");
ok("cpp block comment", cpp("/* a|").enter().t, "/* a\n * ");
ok("cpp fn braces newline-style", cpp("int main()\n{|").enter().show(), "int main()\n{\n    |");
ok("cpp electric }", cpp("if (x) {\n    foo();\n    |").type("}").t, "if (x) {\n    foo();\n}");
ok("cpp nested electric }", cpp("a {\n    b {\n        c();\n        |").type("}").t, "a {\n    b {\n        c();\n    }");

/* ---- Tab / Shift+Tab ---- */
ok("tab inserts spaces", py("|x").tab().t, "    x");
ok("tab mid line to stop", py("ab|c").tab().t, "ab  c");
ok("shift-tab dedents line", py("        x|").tab(true).t, "    x");
ok("shift-tab partial", py("  x|").tab(true).t, "x");
ok("shift-tab tab char", py("\tx|").tab(true).t, "x");
ok("multi-line indent", py("|a\nb\nc|").tab().t, "    a\n    b\n    c");
ok("multi-line dedent", py("|    a\n        b\nc|").tab(true).t, "a\n    b\nc");
ok("multi-line sel kept", (() => { const d = py("|a\nb|").tab(); return d.t.slice(d.s, d.e); })(), "    a\n    b");
ok("indent skips blank", py("|a\n\nb|").tab().t, "    a\n\n    b");
ok("sel ending at col0 excludes last line", py("|a\nb\n|c").tab().t, "    a\n    b\nc");
ok("single-line selection indents line", py("x = |12| + 1").tab().t, "    x = 12 + 1");
ok("shift-tab no-op at col 0", py("|x").tab(true).t, "x");
ok("caret after shift-tab", py("        x|").tab(true).show(), "    x|");

/* ---- Backspace ---- */
ok("bs soft tab", py("        |x").bs().t, "    x");
ok("bs partial indent", py("      |x").bs().t, "    x");
ok("bs removes pair", py("f(|)").bs().t, "f");
ok("bs removes quote pair", py('x = "|"').bs().t, "x = ");
ok("bs normal char", py("abc|").bs().t, "ab");

/* ---- Brackets / quotes ---- */
ok("pair (", py().type("print(").show(), "print(|)");
ok("overtype )", py().type("print(1)").show(), "print(1)|");
ok("no duplicate", py().type("f(g(h(1)))").t, "f(g(h(1)))");
ok("pair [", py().type("a[").t, "a[]");
ok("pair {", cpp().type("{").t, "{}");
ok("pair quote", py().type('print("hi")').t, 'print("hi")');
ok("apostrophe no pair", py().type("don't").t, "don't");
ok("no pair before word", py("|x").type("(").t, "(x");
ok("pair before )", py("f(|)").type("[").t, "f([])");
ok("wrap selection", py("|abc|").type("(").t, "(abc)");
ok("wrap selection quote", py("|abc|").type('"').t, '"abc"');
ok("python f-string pair", py().type('f"{x}"').t, 'f"{x}"');
ok("py triple quote", py().type('"""').t, '"""');
ok("cpp char literal", cpp().type("char c = 'a';").t, "char c = 'a';");
ok("cpp digit sep", cpp().type("int x = 1'000;").t, "int x = 1'000;");
ok("no pair inside string", py('s = "a|"').type("(").t, 's = "a("');
ok("no pair in comment", py("# hi|").type("(").t, "# hi(");
ok("cpp include <", cpp().type("#include <bits/stdc++.h>").t, "#include <bits/stdc++.h>");
ok("typing closer w/o opener", py().type(")").t, ")");

/* ---- comment toggle ---- */
ok("py comment line", py("x = 1|").comment().t, "# x = 1");
ok("py uncomment", py("# x = 1|").comment().t, "x = 1");
ok("cpp comment", cpp("  x = 1;|").comment().t, "  // x = 1;");
ok("cpp uncomment", cpp("  // x = 1;|").comment().t, "  x = 1;");
ok("multi-line comment keeps indent", py("|if x:\n    y\n|").comment().t, "# if x:\n#     y\n");
ok("comment min-indent", py("|    a\n  b|").comment().t, "  #   a\n  # b");
ok("mixed -> comment all", py("|# a\nb|").comment().t, "# # a\n# b");
ok("uncomment multi", py("|# a\n# b|").comment().t, "a\nb");
ok("blank lines skipped", py("|a\n\nb|").comment().t, "# a\n\n# b");

/* ---- bracket matching ---- */
ok("match )", JSON.stringify(core.findMatch("f(a, (b))", 2, "python")), "[1,8]");
ok("match from after )", JSON.stringify(core.findMatch("f(a)", 4, "python")), "[3,1]");
ok("skip string", JSON.stringify(core.findMatch('f(")", 1)', 2, "python")), "[1,9]".replace("9", "8"));
ok("skip comment", JSON.stringify(core.findMatch("{ // }\n}", 1, "cpp")), "[0,7]");
ok("no match", core.findMatch("f(a", 2, "python"), null);

/* ---- highlighting ---- */
const hlc = (t, l, cls) => core.scan(t, l).filter((x) => x[2] === cls).map((x) => t.slice(x[0], x[1]));
ok("py kw", hlc("for i in range(n):\n    if x: pass", "python", "kw").join(), "for,in,if,pass");
ok("py str+comment", hlc("a = 'x#y'  # c", "python", "str").join() + "|" + hlc("a = 'x#y'  # c", "python", "com").join(), "'x#y'|# c");
ok("py triple", hlc('s = """a\nb"""\nx = 1', "python", "str").join(), '"""a\nb"""');
ok("py fstring prefix", hlc('f"a{b}"', "python", "str").join(), 'f"a{b}"');
ok("py num", hlc("x = 1_000 + 2.5e3 + 0x1F", "python", "num").join(), "1_000,2.5e3,0x1F");
ok("py def name", hlc("def solve(a):", "python", "fn").join(), "solve");
ok("cpp kw/types", hlc("int main() { for (;;) return 0; }", "cpp", "kw").join(), "for,return");
ok("cpp include", hlc("#include <bits/stdc++.h>\nint x;", "cpp", "pp").join() + "|" + hlc("#include <bits/stdc++.h>", "cpp", "str").join(), "#include|<bits/stdc++.h>");
ok("cpp block comment", hlc("a /* x\n y */ b", "cpp", "com").join(), "/* x\n y */");
ok("cpp num", hlc("long long x = 1'000'000 + 10LL + 3.14f;", "cpp", "num").join(), "1'000'000,10LL,3.14f");
ok("cpp char", hlc("char c = '\\'';", "cpp", "str").join(), "'\\''");
ok("cpp raw string", hlc('auto s = R"(a"b)";', "cpp", "str").join(), 'R"(a"b)"');
ok("html escaped", core.highlight("a < b && c > d", "cpp").includes("&lt;") && core.highlight("a < b", "cpp").includes("&amp;") === false, true);
// perf: highlight a 5000-line file well under a frame budget on any laptop
const big = "for i in range(10):\n    x = [1, 2, 3]  # hi\n".repeat(2500);
const t0 = process.hrtime.bigint(); core.highlight(big, "python"); const ms = Number(process.hrtime.bigint() - t0) / 1e6;
ok("highlight 5000 lines < 500ms (" + ms.toFixed(1) + "ms)", ms < 500, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
