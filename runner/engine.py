"""Sandboxed-ish local execution engine used by the web server.

Design notes
- Subprocesses run in their own session so a timeout kills the whole group.
- stdout/stderr go to temp files under a file-size ulimit, so a runaway
  print loop can never fill RAM or disk; we then read at most OUT_CAP bytes.
- Address-space ulimit guards against memory bombs.
- Temp files/dirs are always removed.
Verdicts: PASS, WRONG ANSWER, COMPILE ERROR, RUNTIME ERROR,
          TIME LIMIT EXCEEDED, MEMORY LIMIT EXCEEDED, UNSUPPORTED, NO EXAMPLES.
Every failing run carries `error_kind` / `error_title` (timeout, signal,
traceback, nonzero_exit, memory, output_limit, ...) plus exit code and signal
so the UI can explain *why* a program failed instead of just saying "error".
Sample tests are never reported as ACCEPTED.
"""

import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import traceback
from pathlib import Path

from lcparse import parse_example

HERE = Path(__file__).resolve().parent
TIME_LIMIT = 5.0          # seconds per test (same as the original runner)
TOTAL_BUDGET = 40.0       # wall-clock seconds for one whole Run/Submit; later tests are skipped
COMPILE_LIMIT = 30.0
OUT_CAP = 1024 * 1024     # bytes of stdout/stderr we keep per stream (1 MiB)
MAX_CODE_BYTES = 256 * 1024
MAX_STDIN_BYTES = 4 * 1024 * 1024
OUTPUT_FILE_LIMIT_KB = 8192   # a program writing more than ~8 MB is killed (SIGXFSZ)
MARK = "\x00CPRESULT\x00"
PRIORITY = ["COMPILE ERROR", "MEMORY LIMIT EXCEEDED", "RUNTIME ERROR",
            "TIME LIMIT EXCEEDED", "WRONG ANSWER", "UNSUPPORTED", "PASS"]

# NOTE: dash (/bin/sh on Debian/Ubuntu) counts `ulimit -f` in 512-byte blocks,
# bash counts 1024-byte blocks; we only need an order-of-magnitude guard.
_LIMITS = 'ulimit -c 0; ulimit -f {fsz}; ulimit -v {vm}; exec "$@"'
_CLEAN_ENV = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"),
              "PYTHONIOENCODING": "utf-8", "LANG": "C.UTF-8"}


def _read_capped(path, cap=OUT_CAP):
    """Return (text, truncated, total_bytes)."""
    try:
        total = os.path.getsize(path)
        with open(path, "rb") as f:
            data = f.read(cap)
    except OSError:
        return "", False, 0
    return data.decode("utf-8", "replace"), total > cap, total


_SIGNAMES = {
    signal.SIGSEGV: ("SIGSEGV", "Segmentation fault (invalid memory access: out-of-range index, null/dangling pointer, or stack overflow from deep recursion)"),
    signal.SIGABRT: ("SIGABRT", "Aborted (uncaught C++ exception, failed assert, or memory corruption detected)"),
    signal.SIGFPE: ("SIGFPE", "Floating point exception (usually integer division or modulo by zero)"),
    signal.SIGBUS: ("SIGBUS", "Bus error (invalid memory access)"),
    signal.SIGILL: ("SIGILL", "Illegal instruction"),
    signal.SIGKILL: ("SIGKILL", "Process was killed (often out of memory)"),
    signal.SIGXFSZ: ("SIGXFSZ", "Output limit exceeded (the program wrote far too much output)"),
    signal.SIGTERM: ("SIGTERM", "Process was terminated"),
}


def run_process(cmd, stdin_text="", timeout=TIME_LIMIT, cwd=None,
                vm_kb=1_048_576):
    """Run cmd; return dict(returncode, stdout, stderr, timed_out, ms, truncated, ...).

    Extra keys: stdout_truncated/stderr_truncated, stdout_total/stderr_total
    (true byte counts), signal / signal_name / signal_desc (set when the
    process died from a signal).
    """
    tmp = tempfile.mkdtemp(prefix="cp-proc-")
    try:
        in_p, out_p, err_p = (os.path.join(tmp, n) for n in ("in", "out", "err"))
        with open(in_p, "w", encoding="utf-8", errors="replace") as f:
            f.write(stdin_text or "")
        wrapped = ["/bin/sh", "-c",
                   _LIMITS.format(vm=vm_kb, fsz=OUTPUT_FILE_LIMIT_KB), "sh", *cmd]
        start = time.perf_counter()
        timed_out = False
        with open(in_p, "rb") as fin, open(out_p, "wb") as fout, \
                open(err_p, "wb") as ferr:
            proc = subprocess.Popen(
                wrapped, stdin=fin, stdout=fout, stderr=ferr, cwd=cwd,
                env=_CLEAN_ENV, start_new_session=True)
            try:
                proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
            finally:
                # Always reap the whole process group (also grandchildren),
                # even on timeout or if the server thread is interrupted.
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    if timed_out:
                        proc.kill()
                proc.wait()
        ms = int((time.perf_counter() - start) * 1000)
        out, t1, n1 = _read_capped(out_p)
        err, t2, n2 = _read_capped(err_p)
        rc = proc.returncode
        sig = name = desc = None
        if rc is not None and rc < 0 and not timed_out:
            sig = -rc
            try:
                name, desc = _SIGNAMES.get(signal.Signals(sig), (signal.Signals(sig).name, "Terminated by signal %d" % sig))
            except ValueError:
                name, desc = "SIG%d" % sig, "Terminated by signal %d" % sig
        return {"returncode": rc, "stdout": out, "stderr": err,
                "timed_out": timed_out, "ms": ms, "truncated": t1 or t2,
                "stdout_truncated": t1, "stderr_truncated": t2,
                "stdout_total": n1, "stderr_total": n2,
                "signal": sig, "signal_name": name, "signal_desc": desc}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def classify_failure(r, language):
    """Explain a non-zero / timed-out run.

    Returns (verdict, kind, title, detail) or None when the run exited 0.
    kind is one of: timeout, output_limit, memory, signal, traceback,
    exception, nonzero_exit.
    """
    err = r.get("stderr") or ""
    if r.get("timed_out"):
        return ("TIME LIMIT EXCEEDED", "timeout", "Time Limit Exceeded",
                "The program did not finish within %.0f s and was killed "
                "(infinite loop, or an algorithm that is too slow)." % TIME_LIMIT)
    rc = r.get("returncode")
    if rc == 0:
        return None
    # Python ignores SIGXFSZ and fails with OSError(EFBIG) instead; C++ is killed.
    if (r.get("signal") == signal.SIGXFSZ or "Errno 27" in err
            or "File too large" in err
            or r.get("stdout_total", 0) >= OUTPUT_FILE_LIMIT_KB * 512 * 0.9):
        return ("RUNTIME ERROR", "output_limit", "Output Limit Exceeded",
                "The program printed more than about 8 MB and was stopped. "
                "Check for a print inside an infinite loop.")
    if "MemoryError" in err or "std::bad_alloc" in err or "bad_alloc" in err:
        return ("MEMORY LIMIT EXCEEDED", "memory", "Memory Limit Exceeded",
                "The program tried to use more than 1 GiB of memory.")
    if r.get("signal"):
        name, desc = r["signal_name"], r["signal_desc"]
        if r["signal"] == signal.SIGKILL:
            return ("MEMORY LIMIT EXCEEDED", "memory", "Memory Limit Exceeded",
                    "The process was killed by the system, which usually means it ran out of memory.")
        return ("RUNTIME ERROR", "signal", "Runtime Error (%s)" % name, desc)
    if "Traceback (most recent call last)" in err:
        last = [l for l in err.strip().splitlines() if l.strip()][-1] if err.strip() else ""
        return ("RUNTIME ERROR", "traceback", "Runtime Error (Python exception)", last)
    if "terminate called" in err or "what():" in err:
        return ("RUNTIME ERROR", "exception", "Runtime Error (C++ exception)",
                "Uncaught exception; see stderr below.")
    return ("RUNTIME ERROR", "nonzero_exit", "Runtime Error (non-zero exit code)",
            "The process exited with code %s. In C++ `main` should return 0; in "
            "Python check for sys.exit(...) calls." % rc)


def _failure_fields(r, cf):
    """Fields describing exit status, merged into a test/custom result."""
    d = {"exit_code": None if r.get("timed_out") else r.get("returncode"),
         "signal": r.get("signal_name")}
    if cf:
        d.update(error_kind=cf[1], error_title=cf[2], error_detail=cf[3])
    return d


# ---------------------------------------------------------------- comparing
def _tokens(text):
    return text.split()


def _is_float(tok):
    try:
        float(tok)
        return "." in tok or "e" in tok.lower()
    except ValueError:
        return False


def compare_text(actual, expected):
    """Token-wise comparison; floats get a 1e-6 relative/absolute tolerance."""
    a, e = _tokens(actual), _tokens(expected)
    if a == e:
        return True, ""
    if len(a) != len(e):
        return False, ""
    note = False
    for x, y in zip(a, e):
        if x == y:
            continue
        if _is_float(x) and _is_float(y):
            fx, fy = float(x), float(y)
            if abs(fx - fy) <= 1e-6 * max(1.0, abs(fy)):
                note = True
                continue
        return False, ""
    return True, "float tolerance 1e-6 applied" if note else ""


def values_equal(a, b):
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return abs(a - b) <= 1e-5 * max(1.0, abs(b))
    if isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):
        return len(a) == len(b) and all(values_equal(x, y) for x, y in zip(a, b))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(values_equal(a[k], b[k]) for k in a)
    return a == b


def _order_only(a, b):
    try:
        if isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
            key = lambda v: json.dumps(v, sort_keys=True)  # noqa: E731
            return sorted(map(key, a)) == sorted(map(key, b))
    except TypeError:
        pass
    return False


# ---------------------------------------------------------------- compiling
def _compile_cpp(src, exe):
    try:
        r = subprocess.run(
            ["g++", "-std=c++17", "-O2", "-pipe", "-o", str(exe), str(src)],
            capture_output=True, text=True, timeout=COMPILE_LIMIT,
            env=_CLEAN_ENV, cwd=str(Path(src).parent))
    except subprocess.TimeoutExpired:
        return False, "Compilation timed out"
    except FileNotFoundError:
        return False, "g++ is not installed on this machine"
    return r.returncode == 0, (r.stderr or "")[:OUT_CAP]


class Workspace:
    """Writes code to a temp dir; prepares a command for the language.

    Source files are called main.py / main.cpp so that compiler messages and
    tracebacks read `main.cpp:17:12: error: ...` (the temp directory is
    scrubbed from all text shown to the user).
    """

    def __init__(self, language, code):
        self.language, self.code = language, code
        self.dir = Path(tempfile.mkdtemp(prefix="cp-ws-"))
        self.cmd, self.compile_error = None, None

    def clean(self, text):
        return (text or "").replace(str(self.dir) + "/", "")

    def prepare(self):
        if self.language == "python":
            src = self.dir / "main.py"
            src.write_text(self.code, encoding="utf-8")
            self.src = src
            # compile() only parses/byte-compiles, it never executes user code.
            try:
                compile(self.code, "main.py", "exec")
            except (SyntaxError, ValueError) as e:      # includes IndentationError
                self.compile_error = "".join(
                    traceback.format_exception_only(type(e), e)).rstrip()
                return False
            except Exception:                              # RecursionError etc.: let python decide
                pass
            self.cmd = [shutil.which("python3") or sys.executable, "-B", str(src)]
            return True
        src, exe = self.dir / "main.cpp", self.dir / "main"
        src.write_text(self.code, encoding="utf-8")
        self.src = src
        ok, msg = _compile_cpp(src, exe)
        if not ok:
            self.compile_error = self.clean(msg)
            return False
        self.cmd = [str(exe)]
        return True

    def close(self):
        shutil.rmtree(self.dir, ignore_errors=True)


def validate_code(language, code):
    if language not in ("python", "cpp"):
        return "Unsupported language"
    if not isinstance(code, str) or not code.strip():
        return "Code is empty"
    if len(code.encode("utf-8", "replace")) > MAX_CODE_BYTES:
        return "Code is too large (256 KB max)"
    return None


def _finish(result):
    verdicts = [t["verdict"] for t in result["tests"] if t["verdict"] != "SKIPPED"]
    result["passed"] = sum(1 for v in verdicts if v == "PASS")
    result["total"] = len(result["tests"])
    result["verdict"] = next(
        (v for v in PRIORITY if v in verdicts), "NO EXAMPLES")
    result["runtime_ms"] = max((t.get("runtime_ms", 0) for t in result["tests"]),
                               default=0)
    result["label"] = "SAMPLE TEST"
    result["output"] = format_text(result)
    return result


def format_text(r):
    lines = [f"{r['label']} - {r['verdict']}  ({r['passed']}/{r['total']} passed, "
             f"{r['runtime_ms']} ms max)"]
    if r.get("compile_output"):
        lines += ["", "COMPILE OUTPUT", r["compile_output"]]
    for t in r["tests"]:
        lines += ["", f"Example {t['n']}: {t['verdict']} ({t.get('runtime_ms', 0)} ms)"]
        if t["verdict"] == "WRONG ANSWER":
            lines += ["  expected: " + str(t.get("expected", "")),
                      "  got:      " + str(t.get("actual", ""))]
        if t.get("stderr"):
            lines += ["  stderr:", t["stderr"]]
        if t.get("note"):
            lines.append("  note: " + t["note"])
    if r.get("notice"):
        lines += ["", r["notice"]]
    return "\n".join(lines)


# ------------------------------------------------------------- stdin judge
def _skipped(n, inp, exp):
    return {"n": n, "verdict": "SKIPPED", "input": inp[:OUT_CAP], "expected": exp[:OUT_CAP],
            "runtime_ms": 0, "note": "Skipped: the time budget for this run (%d s) was used up "
            "by earlier slow tests." % TOTAL_BUDGET}


def _judge_stdin(ws, examples, tags):
    tests = []
    deadline = time.monotonic() + TOTAL_BUDGET
    limit = TIME_LIMIT
    for n, ex in enumerate(examples, 1):
        inp, exp = str(ex.get("input", "")), str(ex.get("output", ""))
        if time.monotonic() > deadline:
            tests.append(_skipped(n, inp, exp))
            continue
        r = run_process(ws.cmd, inp, timeout=limit)
        if r["timed_out"]:
            limit = min(limit, 2.0)      # don't make the user wait 5 s for every remaining test
        t = {"n": n, "input": inp[:OUT_CAP], "expected": exp[:OUT_CAP],
             "input_bytes": len(inp.encode("utf-8", "replace")),
             "actual": r["stdout"], "stderr": ws.clean(r["stderr"]),
             "actual_truncated": r["stdout_truncated"],
             "actual_bytes": r["stdout_total"],
             "stderr_truncated": r["stderr_truncated"],
             "stderr_bytes": r["stderr_total"],
             "runtime_ms": r["ms"]}
        cf = classify_failure(r, ws.language)
        t.update(_failure_fields(r, cf))
        if cf:
            t["verdict"] = cf[0]
            t["note"] = cf[2] + (": " + cf[3] if cf[3] else "")
        else:
            same, note = compare_text(r["stdout"], exp)
            t["verdict"] = "PASS" if same else "WRONG ANSWER"
            if note:
                t["note"] = note
            if not same and r["stdout_truncated"]:
                t["note"] = "Output was cut at %d KB, comparison used the kept part." % (OUT_CAP // 1024)
        tests.append(t)
    return tests


# --------------------------------------------------------- leetcode judge
def _judge_leetcode(ws, examples):
    tests = []
    harness = str(HERE / "lc_harness.py")
    py = shutil.which("python3") or sys.executable
    for n, ex in enumerate(examples, 1):
        parsed = parse_example(ex.get("example_text", ""))
        if not parsed["ok"]:
            tests.append({"n": n, "verdict": "UNSUPPORTED",
                          "note": parsed["reason"], "input": ex.get("example_text", "")[:500]})
            continue
        payload = json.dumps({"code_path": str(ws.src),
                              "args": [v for _, v in parsed["args"]]})
        r = run_process([py, "-B", harness], payload)
        shown_in = ", ".join(f"{k} = {json.dumps(v)}" for k, v in parsed["args"])
        t = {"n": n, "input": shown_in[:OUT_CAP],
             "expected": json.dumps(parsed["expected"]) if parsed["expected_ok"]
             else str(parsed["expected"]), "runtime_ms": r["ms"]}
        t.update(exit_code=r["returncode"], signal=r["signal_name"])
        if r["timed_out"]:
            t["verdict"] = "TIME LIMIT EXCEEDED"
            t.update(error_kind="timeout", error_title="Time Limit Exceeded",
                     error_detail="The function did not return within %.0f s." % TIME_LIMIT)
            tests.append(t)
            continue
        out, _, tail = r["stdout"].partition(MARK)
        result = None
        if tail.strip():
            try:
                result = json.loads(tail.strip().splitlines()[0])
            except ValueError:
                result = None
        if result is None:
            cf = classify_failure(r, "python")
            t["verdict"] = cf[0] if cf else "RUNTIME ERROR"
            t.update(error_kind=cf[1] if cf else "nonzero_exit",
                     error_title=cf[2] if cf else "Runtime Error",
                     error_detail=cf[3] if cf else "Process exited without a result")
            t["stderr"] = ws.clean(r["stderr"] or "Process exited without a result")[:OUT_CAP]
        elif not result["ok"]:
            t["verdict"] = "RUNTIME ERROR"
            t.update(error_kind="traceback", error_title="Runtime Error (Python exception)",
                     error_detail=result.get("error", ""))
            t["stderr"] = ws.clean(result.get("traceback") or result.get("error", ""))
        else:
            value = result["value"]
            t["actual"] = json.dumps(value)[:OUT_CAP]
            if parsed["expected_ok"]:
                same = values_equal(value, parsed["expected"])
            else:
                same = str(value).strip() == str(parsed["expected"]).strip()
            t["verdict"] = "PASS" if same else "WRONG ANSWER"
            if not same and parsed["expected_ok"] and _order_only(value, parsed["expected"]):
                t["note"] = ("Same elements, different order - LeetCode may accept "
                             "any order for this problem, but this cannot be verified offline.")
        if out.strip():
            t["stdout"] = out[:OUT_CAP]
        tests.append(t)
    return tests


# ------------------------------------------------------------- public API
def judge_examples(problem, language, code):
    """problem: dict with platform, examples (JSON text), tags (list)."""
    err = validate_code(language, code)
    if err:
        return {"verdict": "ERROR", "error": err, "tests": [], "passed": 0,
                "total": 0, "label": "SAMPLE TEST", "output": err, "runtime_ms": 0}
    raw = problem.get("examples") or []
    if isinstance(raw, str):
        try:
            raw = json.loads(raw or "[]")
        except ValueError:
            raw = []
    examples = raw
    if not isinstance(examples, list):
        examples = []
    examples = [e for e in examples if isinstance(e, dict)][:20]

    base = {"tests": [], "label": "SAMPLE TEST", "passed": 0, "total": 0,
            "runtime_ms": 0}
    if not examples:
        base.update(verdict="NO EXAMPLES", output=(
            "This problem has no stored examples, so nothing can be tested "
            "locally. Use Custom Input to run your code by hand."))
        return base
    platform = problem.get("platform")
    tags = [t.lower() for t in problem.get("tags", [])]
    if platform == "codeforces" and "interactive" in tags:
        base.update(verdict="UNSUPPORTED", output=(
            "Interactive problems need an interactor, which is not available "
            "offline. Use Custom Input to test pieces manually."))
        return base
    if platform == "leetcode" and language == "cpp":
        base.update(verdict="UNSUPPORTED", output=(
            "LeetCode problems are function-signature based; there is no stdin "
            "format to feed a C++ program, so automatic example testing is only "
            "available for Python. You can still compile and run C++ with "
            "Custom Input."))
        return base

    ws = Workspace(language, code)
    try:
        if not ws.prepare():
            base.update(verdict="COMPILE ERROR", compile_output=ws.compile_error,
                        error_kind="compile", error_title="Compilation Error")
            base["output"] = "COMPILE ERROR\n" + (ws.compile_error or "")
            return base
        tests = (_judge_leetcode(ws, examples) if platform == "leetcode"
                 else _judge_stdin(ws, examples, tags))
    finally:
        ws.close()
    base["tests"] = tests
    res = _finish(base)
    if platform == "codeforces" and res["verdict"] == "WRONG ANSWER":
        res["notice"] = ("Note: many Codeforces problems accept several valid "
                         "answers via a checker; compare 'expected' and 'got' "
                         "yourself before assuming a bug.")
        res["output"] = format_text(res)
    elif res["verdict"] == "PASS":
        res["notice"] = ("These are only the sample examples from the statement. "
                         "Passing them is not an accepted solution.")
        res["output"] = format_text(res)
    return res


def run_custom(language, code, stdin_text):
    err = validate_code(language, code)
    if err:
        return {"verdict": "ERROR", "error": err, "output": err}
    stdin_text = (stdin_text or "")[:MAX_STDIN_BYTES]
    ws = Workspace(language, code)
    try:
        if not ws.prepare():
            return {"verdict": "COMPILE ERROR", "stdout": "",
                    "stderr": ws.compile_error, "runtime_ms": 0,
                    "compile_output": ws.compile_error,
                    "error_kind": "compile", "error_title": "Compilation Error",
                    "output": "COMPILE ERROR\n" + (ws.compile_error or "")}
        r = run_process(ws.cmd, stdin_text)
    finally:
        ws.close()
    cf = classify_failure(r, language)
    verdict = cf[0] if cf else "OK"
    stderr = ws.clean(r["stderr"])
    text = r["stdout"] + (("\n[stderr]\n" + stderr) if stderr else "")
    if r["truncated"]:
        text += "\n[output truncated]"
    res = {"verdict": verdict, "stdout": r["stdout"], "stderr": stderr,
           "returncode": r["returncode"], "runtime_ms": r["ms"],
           "truncated": r["truncated"],
           "stdout_truncated": r["stdout_truncated"],
           "stderr_truncated": r["stderr_truncated"],
           "stdout_bytes": r["stdout_total"], "stderr_bytes": r["stderr_total"],
           "output": text or "(no output)"}
    res.update(_failure_fields(r, cf))
    return res
