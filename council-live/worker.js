// S9 slice 1 worker (PREREG_S68_S9_1.md B4, PREREG_S69_S9_1.md): a module worker with its own .NET runtime. Files are fetched from the hosted paths named by the manifest and each one is checked against its SHA-256 BEFORE it
// enters the run (a broken download is stopped by name). The flagged-rows file (exceptions.csv) arrives from the host chunk by chunk, is parsed here and posted to the page in batches; nothing else the run writes is kept, and nothing is uploaded.
// The host's console lines (including its own digest lines) are passed on as plain log text: the page does nothing with them.
import { dotnet } from './_framework/dotnet.js';
const ABORT_TEXT = /Garbage collector could not allocate|could not allocate \d+u? bytes|out of memory|memory access out of bounds|RuntimeError: (Aborted|unreachable)|Aborted\(/i;
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
const KEEP = ['Year', 'Schedule', 'GroupId', 'TransactionId', 'SupplierName', 'Net', 'Gross', 'Difference', 'Detail', 'Classification', 'ExplainedBy', 'ExplainedMeaning'];

// An incremental CSV reader: quotes, doubled quotes and line breaks inside quotes; a chunk may end anywhere (even between the two quotes of a doubled quote).
class CsvFeed {
  constructor(onRecord) { this.onRecord = onRecord; this.field = ''; this.rec = []; this.inQ = false; this.pendingQ = false; this.cr = false; this.any = false; }
  feed(s) {
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (this.pendingQ) { this.pendingQ = false; if (c === '"') { this.field += '"'; continue; } this.inQ = false; }       // after a quote inside quotes: a second quote is a literal quote, anything else closes the field
      if (this.inQ) { if (c === '"') this.pendingQ = true; else this.field += c; continue; }
      if (this.cr) { this.cr = false; if (c === '\n') continue; }
      if (c === '"' && this.field === '') { this.inQ = true; this.any = true; }
      else if (c === ',') { this.rec.push(this.field); this.field = ''; this.any = true; }
      else if (c === '\n' || c === '\r') { if (c === '\r') this.cr = true; this.end(); }
      else { this.field += c; this.any = true; }
    }
  }
  end() { if (this.any || this.rec.length > 0 || this.field !== '') { this.rec.push(this.field); this.onRecord(this.rec); } this.field = ''; this.rec = []; this.any = false; }
  finish() { if (this.pendingQ) { this.pendingQ = false; this.inQ = false; } this.end(); }
}

self.onmessage = async (e) => {
  let reported = false;
  const report = (detail) => { if (reported) return; reported = true; postMessage({ type: 'failed', detail }); };
  try {
    const { slug, inputs, window, softHeapLimit, retries, crash, throwAfter, checkDigests } = e.data;
    const byPath = new Map(inputs.map((f) => [f.path, f]));
    let linear = () => 0;
    const post = (text) => postMessage({ type: 'log', text });
    const onOut = (text) => post(String(text));
    const onErr = (text) => { post(text); if (ABORT_TEXT.test(String(text))) report(JSON.stringify({ error: 'runtime-abort', text: String(text).slice(0, 300), linearMB: linear() })); };
    const onAbort = (reason) => report(JSON.stringify({ error: 'runtime-abort', text: String(reason).slice(0, 300), linearMB: linear() }));
    let builder = dotnet.withModuleConfig({ out: onOut, err: onErr, onAbort }).withApplicationArguments(slug, 'inbox/', 'browser', String(window ?? 4), 'beat', '0', crash ? 'crash' : '', crash === 'later' ? 'later' : '', throwAfter ?? '');
    if (softHeapLimit) builder = builder.withEnvironmentVariable('MONO_GC_PARAMS', 'soft-heap-limit=' + softHeapLimit);
    const runtime = await builder.create();
    linear = () => Math.round(runtime.Module.HEAPU8.length / 1048576);
    const maxRetry = retries ?? 3, t0 = performance.now(); let fetched = 0, bytes = 0;
    const stopRun = (error, extra) => { report(JSON.stringify({ error, ...extra })); throw new Error(error + ' ' + (extra.file ?? '')); };

    // ---- the flagged rows: decode, parse, post in batches of 2000 (a few ms each on the page's thread)
    const dec = new TextDecoder('utf-8'); let idx = null, batch = [], rowCount = 0, byteCount = 0, header = true;
    const csv = new CsvFeed((rec) => {
      if (header) { header = false; idx = KEEP.map((k) => rec.indexOf(k)); if (idx.includes(-1)) { report(JSON.stringify({ error: 'exceptions-header', detail: 'missing ' + KEEP.filter((k, i) => idx[i] < 0).join(',') })); } return; }
      if (!idx) return; batch.push(idx.map((i) => rec[i] ?? '')); rowCount++;
      if (batch.length >= 2000) { postMessage({ type: 'rows', rows: batch }); batch = []; }
    });

    runtime.setModuleImports('main.mjs', {
      readFile: () => null,
      fetchFile: async (url) => {
        const rel = String(url).replace(/^inbox\//, ''); const ent = byPath.get(rel);
        if (!ent) stopRun('input-not-in-manifest', { file: rel });
        for (let a = 0; ; a++) {
          try {
            const r = await fetch(ent.hosted);
            if (r.status === 404) stopRun('input-missing', { file: rel, detail: 'HTTP 404' });
            if (!r.ok) stopRun('input-missing', { file: rel, detail: 'HTTP ' + r.status });
            const buf = await r.arrayBuffer();
            if (checkDigests) {
              const got = hex(await crypto.subtle.digest('SHA-256', buf));
              if (got !== ent.sha256 || buf.byteLength !== ent.bytes) stopRun('input-digest-mismatch', { file: rel, expected: ent.sha256, got, bytesExpected: ent.bytes, bytesGot: buf.byteLength });
            }
            fetched++; bytes += buf.byteLength; return new Uint8Array(buf);
          } catch (err) {
            if (reported) throw err;       // a deliberate stop (missing, mismatch) is not retried
            post('FETCHFAIL ' + JSON.stringify({ file: rel, attempt: a + 1, name: err?.name, message: String(err?.message ?? err), filesFetched: fetched, mbFetched: Math.round(bytes / 1048576), linearMB: linear(), atS: Math.round((performance.now() - t0) / 100) / 10 }));
            if (a >= maxRetry) { stopRun('input-missing', { file: rel, detail: 'fetch failed after ' + (a + 1) + ' attempts: ' + String(err?.message ?? err) }); }
            await new Promise((res) => setTimeout(res, 300 * (a + 1)));
          }
        }
      },
      heapBytes: () => runtime.Module.HEAPU8.length,
      progress: (stage, files, rows, running) => postMessage({ type: 'progress', stage, files, rows, running, linearMB: linear() }),
      exceptionsChunk: (u8) => { byteCount += u8.length; csv.feed(dec.decode(u8, { stream: true })); },
      exceptionsEnd: () => { csv.feed(dec.decode()); csv.finish(); if (batch.length) { postMessage({ type: 'rows', rows: batch }); batch = []; } post(`EXCEPTIONS bytes=${byteCount} rows=${rowCount}`); postMessage({ type: 'rowsEnd', rows: rowCount, bytes: byteCount }); },
      done: (summary) => postMessage({ type: 'done', summary }),
      failed: (detail) => report(detail),
    });
    await runtime.runMain();
  } catch (err) {
    const text = String(err);
    if (ABORT_TEXT.test(text)) report(JSON.stringify({ error: 'runtime-abort', text: text.slice(0, 300) }));
    else if (!reported) postMessage({ type: 'error', error: text });
  }
};
