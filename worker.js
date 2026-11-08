/* Pyratik — Python'u tarayıcıda çalıştıran Web Worker.
 *
 * Python, Pyodide ile (WebAssembly'ye derlenmiş CPython) ziyaretçinin kendi
 * tarayıcısında, sayfadan ayrı bu işçide çalışır; kod hiçbir sunucuya gitmez.
 * Dosya sistemi sanaldır ve sekmeye özeldir; süreç başlatılamaz, ham ağ
 * bağlantısı açılamaz. Etkin çalışma 5 saniyeyi geçerse sayfa bu işçiyi
 * sonlandırıp yenisini başlatır (index.html → TIMEOUT_MS). Modül işçisi olarak
 * açılır; Pyodide 314 klasik işçileri desteklemiyor.
 */
const PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/';
const FLUSH_MS = 50;        // çıktı sayfaya en geç bu aralıkla gönderilir
const FLUSH_CHARS = 4096;   // ya da bu kadar karakter birikince

// input() için hazır değer yoksa program _NeedInput ile durur; sayfa kullanıcıya
// sorar ve programı o ana kadar girilen değerlerle baştan çalıştırır.
const RUNNER = String.raw`
import builtins, io, linecache, os, sys, traceback

MAX_OUT = 20_000  # program çıktısı sınırı (karakter); telefonda konsol akıcı kalsın


class _NeedInput(BaseException):
    pass


class _OutputLimit(BaseException):
    pass


_state = {"inputs": [], "pos": 0, "chars": 0, "truncated": False}


class _Stream(io.TextIOBase):
    def __init__(self, kind):
        self.kind = kind

    @property
    def encoding(self):
        return "utf-8"

    def writable(self):
        return True

    def write(self, s):
        if not isinstance(s, str):
            raise TypeError(f"write() argument must be str, not {type(s).__name__}")
        room = MAX_OUT - _state["chars"]
        if len(s) > room:
            s, _state["truncated"] = s[:room], True
        _state["chars"] += len(s)
        if s:
            _emit(self.kind, s)
        if _state["truncated"]:
            raise _OutputLimit
        return len(s)


_out, _err = _Stream("out"), _Stream("err")


def _input(prompt=""):
    if _state["pos"] < len(_state["inputs"]):
        _state["pos"] += 1
        return _state["inputs"][_state["pos"] - 1]
    raise _NeedInput(str(prompt))


def _report(exc):
    # Hata çıktısında başlatıcının (<exec>) satırları gizlenir, main.py görünür.
    te = traceback.TracebackException(type(exc), exc, exc.__traceback__)
    te.stack = traceback.StackSummary.from_list(
        [f for f in te.stack if f.filename != "<exec>"])
    _err.write("".join(te.format()))


def _failed(write):
    try:
        write()
    except _OutputLimit:
        return ["done", 1, True]
    return ["done", 1, False]


_BUILTINS = dict(builtins.__dict__)
_HOME = os.getcwd()


def _run(code, inputs):
    # Her çalıştırma temiz başlar: yerleşikler, akışlar ve çalışma dizini sıfırlanır.
    builtins.__dict__.clear()
    builtins.__dict__.update(_BUILTINS)
    builtins.input = _input
    sys.stdout, sys.stderr, sys.stdin = _out, _err, io.StringIO()
    sys.argv = ["main.py"]
    os.chdir(_HOME)
    with open("main.py", "w", encoding="utf-8") as f:
        f.write(code)
    linecache.clearcache()
    _state.update(inputs=list(inputs), pos=0, chars=0, truncated=False)
    try:
        exec(compile(code, "main.py", "exec"),
             {"__name__": "__main__", "__file__": "main.py", "__builtins__": builtins})
    except _NeedInput as e:
        return ["prompt", e.args[0], False]
    except _OutputLimit:
        return ["done", 1, True]
    except SystemExit as e:
        if e.code is None or isinstance(e.code, int):
            return ["done", e.code or 0, False]
        return _failed(lambda: _err.write(f"{e.code}\n"))
    except BaseException as e:
        return _failed(lambda: _report(e))
    return ["done", 0, False]
`;

let run = null;   // Python'daki _run
let job = null;   // { id, skip, buf, len, last }

function flush(now = performance.now()) {
  if (job.buf.length) postMessage({ type: 'out', id: job.id, chunks: job.buf });
  job.buf = [];
  job.len = 0;
  job.last = now;
}

// Python'dan çağrılır. Yeniden çalıştırmada önceden gösterilen çıktı atlanır.
function emit(kind, text) {
  if (job.skip > 0) {
    if (text.length <= job.skip) { job.skip -= text.length; return; }
    text = text.slice(job.skip);
    job.skip = 0;
  }
  const last = job.buf[job.buf.length - 1];
  if (last && last[0] === kind) last[1] += text;
  else job.buf.push([kind, text]);
  job.len += text.length;
  const now = performance.now();
  if (job.len >= FLUSH_CHARS || now - job.last >= FLUSH_MS) flush(now);
}

import(PYODIDE + 'pyodide.mjs')
  .then(({ loadPyodide }) => loadPyodide({ indexURL: PYODIDE }))
  .then((py) => {
    py.globals.set('_emit', emit);
    py.runPython(RUNNER);
    run = py.globals.get('_run');
    postMessage({ type: 'ready' });
  })
  .catch((err) => {
    postMessage({ type: 'loaderror', message: String((err && err.message) || err) });
  });

self.onmessage = ({ data: m }) => {
  if (!m || m.type !== 'run' || !run) return;
  job = { id: m.id, skip: m.skip || 0, buf: [], len: 0, last: performance.now() };
  const t0 = performance.now();
  let res;
  try {
    const proxy = run(m.code, m.inputs);
    res = proxy.toJs();
    proxy.destroy();
  } catch (err) {
    flush();
    postMessage({ type: 'crash', id: m.id, message: String((err && err.message) || err) });
    self.close();
    return;
  }
  flush();
  const ms = performance.now() - t0;
  if (res[0] === 'prompt') postMessage({ type: 'prompt', id: m.id, v: res[1], ms });
  else postMessage({ type: 'done', id: m.id, rc: res[1], truncated: res[2], ms });
  job = null;
};
