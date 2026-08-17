"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./replay-lab.module.css";

type Result = {
  id: number;
  label: string;
  method: string;
  url: string;
  status: number | "ERR";
  durationMs: number;
  body: string;
  headers: Record<string, string>;
};

type RequestSpec = {
  label: string;
  url: string;
  init?: RequestInit;
};

type BrowserState = {
  local: string | null;
  session: string | null;
  cookie: string | null;
};

const emptyBrowserState: BrowserState = { local: null, session: null, cookie: null };

function readBrowserState(): BrowserState {
  return {
    local: localStorage.getItem("koko-replay-lab:local"),
    session: sessionStorage.getItem("koko-replay-lab:session"),
    cookie: document.cookie || null,
  };
}

const baselineRequests: RequestSpec[] = [
  { label: "Stable profile JSON", url: "/api/replay-lab/profile" },
  { label: "Feature flags", url: "/api/replay-lab/flags" },
  { label: "Editable text document", url: "/api/replay-lab/document" },
  { label: "Slow response (700 ms)", url: "/api/replay-lab/slow?ms=700" },
];

function prettyBody(value: string) {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

export default function ReplayLabPage() {
  const [results, setResults] = useState<Result[]>([]);
  const [running, setRunning] = useState<string[]>([]);
  const [browserState, setBrowserState] = useState<BrowserState>(emptyBrowserState);
  const sequence = useRef(0);
  const baselineStarted = useRef(false);

  const runRequest = useCallback(async (spec: RequestSpec) => {
    setRunning((current) => [...current, spec.label]);
    const startedAt = performance.now();
    const method = spec.init?.method ?? "GET";
    try {
      const response = await fetch(spec.url, { credentials: "include", ...spec.init });
      const body = await response.text();
      const result: Result = {
        id: ++sequence.current,
        label: spec.label,
        method,
        url: response.url || spec.url,
        status: response.status,
        durationMs: Math.round(performance.now() - startedAt),
        body: prettyBody(body),
        headers: {
          contentType: response.headers.get("content-type") ?? "—",
          replayCase: response.headers.get("x-replay-lab-case") ?? "—",
          serverTiming: response.headers.get("server-timing") ?? "—",
        },
      };
      setResults((current) => [result, ...current].slice(0, 30));
      return result;
    } catch (error) {
      const result: Result = {
        id: ++sequence.current,
        label: spec.label,
        method,
        url: spec.url,
        status: "ERR",
        durationMs: Math.round(performance.now() - startedAt),
        body: error instanceof Error ? error.message : "Unknown fetch error",
        headers: {},
      };
      setResults((current) => [result, ...current].slice(0, 30));
      return result;
    } finally {
      setRunning((current) => current.filter((label) => label !== spec.label));
    }
  }, []);

  const runBaseline = useCallback(async () => {
    await Promise.all(baselineRequests.map(runRequest));
  }, [runRequest]);

  useEffect(() => {
    if (baselineStarted.current) return;
    baselineStarted.current = true;
    setBrowserState(readBrowserState());
    void runBaseline();
  }, [runBaseline]);

  const setCheckpointState = () => {
    localStorage.setItem("koko-replay-lab:local", "local-storage-checkpoint-v1");
    sessionStorage.setItem("koko-replay-lab:session", "session-storage-checkpoint-v1");
    document.cookie = "koko_replay_lab_client=browser-checkpoint-v1; Path=/; SameSite=Lax";
    setBrowserState(readBrowserState());
    void runRequest({ label: "Set-Cookie response", url: "/api/replay-lab/cookie" });
  };

  const clearBrowserState = () => {
    localStorage.removeItem("koko-replay-lab:local");
    sessionStorage.removeItem("koko-replay-lab:session");
    document.cookie = "koko_replay_lab_client=; Max-Age=0; Path=/";
    document.cookie = "koko_replay_lab=; Max-Age=0; Path=/";
    setBrowserState(readBrowserState());
  };

  return (
    <main className={styles.page}>
      <header className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>Koko Observatory fixture</p>
          <h1>Replay Test Lab</h1>
          <p className={styles.lead}>
            Một site giả lập có response ổn định, lỗi, delay, redirect và browser state để record rồi kiểm tra Replay Studio.
          </p>
        </div>
        <div className={styles.liveBadge}><span /> Fixture online</div>
      </header>

      <section className={styles.guide} aria-labelledby="quick-start-title">
        <div>
          <p className={styles.step}>Quy trình đề xuất</p>
          <h2 id="quick-start-title">Record → Edit → Replay → Compare</h2>
        </div>
        <ol>
          <li>Inspect URL <code>/replay-lab</code> trong Observatory.</li>
          <li>Chọn execution mới trong Replay Studio.</li>
          <li>Sửa body/status, thêm breakpoint hoặc tắt một response.</li>
          <li>Run replay plan và so sánh kết quả bên dưới.</li>
        </ol>
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHeading}>
          <div>
            <p className={styles.step}>01 · Capturable inputs</p>
            <h2>Bộ request baseline</h2>
            <p>Tự chạy khi trang mở; tất cả response đều là JSON hoặc text hoàn chỉnh.</p>
          </div>
          <button className={styles.primaryButton} type="button" onClick={() => void runBaseline()}>
            Chạy lại baseline
          </button>
        </div>
        <div className={styles.cardGrid}>
          {baselineRequests.map((request) => (
            <article className={styles.scenarioCard} key={request.url}>
              <span className={styles.method}>GET</span>
              <h3>{request.label}</h3>
              <code>{request.url}</code>
              <button type="button" onClick={() => void runRequest(request)} disabled={running.includes(request.label)}>
                {running.includes(request.label) ? "Đang chạy…" : "Run request"}
              </button>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHeading}>
          <div>
            <p className={styles.step}>02 · Edge cases</p>
            <h2>Kịch bản riêng lẻ</h2>
            <p>Dùng để kiểm tra status override, redirect, POST body, strict miss và dữ liệu không ổn định.</p>
          </div>
        </div>
        <div className={styles.actionGrid}>
          <button type="button" onClick={() => void runRequest({ label: "HTTP 503", url: "/api/replay-lab/error" })}>
            <strong>HTTP 503</strong><span>Response lỗi có Retry-After</span>
          </button>
          <button type="button" onClick={() => void runRequest({ label: "302 redirect", url: "/api/replay-lab/redirect" })}>
            <strong>302 Redirect</strong><span>Theo redirect tới JSON đích</span>
          </button>
          <button type="button" onClick={() => void runRequest({ label: "POST echo", url: "/api/replay-lab/echo", init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "checkout", quantity: 2, fixture: true }) } })}>
            <strong>POST Echo</strong><span>Kiểm tra request body/method</span>
          </button>
          <button type="button" onClick={() => void runRequest({ label: "Changing clock", url: "/api/replay-lab/clock" })}>
            <strong>Changing data</strong><span>Timestamp và UUID mới mỗi lần</span>
          </button>
          <button type="button" onClick={() => void runRequest({ label: "Uncaptured URL", url: `/api/replay-lab/live-miss?nonce=${Date.now()}` })}>
            <strong>Strict network miss</strong><span>URL query chưa từng capture</span>
          </button>
          <button type="button" onClick={setCheckpointState}>
            <strong>Seed checkpoint state</strong><span>Cookie + local/session storage</span>
          </button>
        </div>
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHeading}>
          <div>
            <p className={styles.step}>03 · Checkpoint state</p>
            <h2>Browser state hiện tại</h2>
          </div>
          <button className={styles.secondaryButton} type="button" onClick={clearBrowserState}>Xóa browser state</button>
        </div>
        <div className={styles.stateGrid}>
          <div><span>localStorage</span><code>{browserState.local ?? "not set"}</code></div>
          <div><span>sessionStorage</span><code>{browserState.session ?? "not set"}</code></div>
          <div><span>cookie</span><code>{browserState.cookie ?? "not set"}</code></div>
        </div>
      </section>

      <section className={styles.panel} aria-live="polite">
        <div className={styles.panelHeading}>
          <div>
            <p className={styles.step}>04 · Results</p>
            <h2>Response log</h2>
            <p>Kết quả mới nhất nằm trên cùng. Body đã format để dễ nhìn thấy replay override.</p>
          </div>
          <button className={styles.secondaryButton} type="button" onClick={() => setResults([])}>Clear log</button>
        </div>
        <div className={styles.results}>
          {results.length === 0 && <p className={styles.empty}>Đang chờ response…</p>}
          {results.map((result) => (
            <details className={styles.result} key={result.id} open={result.id <= 2}>
              <summary>
                <span className={styles.method}>{result.method}</span>
                <strong>{result.label}</strong>
                <code>{result.status}</code>
                <span>{result.durationMs} ms</span>
              </summary>
              <div className={styles.resultMeta}>
                <code>{result.url}</code>
                <span>x-replay-lab-case: {result.headers.replayCase ?? "—"}</span>
              </div>
              <pre>{result.body}</pre>
            </details>
          ))}
        </div>
      </section>
    </main>
  );
}
