type RouteContext = {
  params: Promise<{ scenario: string }>;
};

const jsonHeaders = {
  "cache-control": "no-store",
  "x-replay-lab": "true",
};

function json(body: unknown, init: ResponseInit = {}) {
  return Response.json(body, {
    ...init,
    headers: { ...jsonHeaders, ...init.headers },
  });
}

function text(body: string, init: ResponseInit = {}) {
  return new Response(body, {
    ...init,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "x-replay-lab": "true",
      ...init.headers,
    },
  });
}

async function wait(milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function GET(request: Request, context: RouteContext) {
  const { scenario } = await context.params;
  const url = new URL(request.url);

  switch (scenario) {
    case "profile":
      return json({
        id: "usr_replay_001",
        name: "Koko Replay Tester",
        plan: "observatory-lab",
        permissions: ["read", "edit", "replay"],
      }, { headers: { "x-replay-lab-case": "profile" } });

    case "flags":
      return json({
        replayEditor: true,
        networkBreakpoints: true,
        experimentalBranching: false,
      }, { headers: { "x-replay-lab-case": "flags" } });

    case "document":
      return text(
        "KOKO_REPLAY_DOCUMENT_V1\nThis body is intentionally stable and safe to edit during replay.\n",
        { headers: { "x-replay-lab-case": "document" } },
      );

    case "slow": {
      const requestedDelay = Number(url.searchParams.get("ms") ?? 700);
      const delayMs = Number.isFinite(requestedDelay)
        ? Math.min(Math.max(requestedDelay, 0), 5_000)
        : 700;
      await wait(delayMs);
      return json(
        { ok: true, delayedByMs: delayMs, marker: "SLOW_RESPONSE_COMPLETE" },
        { headers: { "server-timing": `replay-lab;dur=${delayMs}`, "x-replay-lab-case": "slow" } },
      );
    }

    case "error":
      return json(
        { ok: false, code: "SIMULATED_UPSTREAM_FAILURE", retryable: true },
        { status: 503, headers: { "retry-after": "3", "x-replay-lab-case": "error" } },
      );

    case "redirect":
      return Response.redirect(new URL("/api/replay-lab/redirect-target", url), 302);

    case "redirect-target":
      return json(
        { ok: true, redirected: true, destination: "redirect-target" },
        { headers: { "x-replay-lab-case": "redirect-target" } },
      );

    case "cookie":
      return json(
        { ok: true, cookieName: "koko_replay_lab", expectedValue: "checkpoint-v1" },
        {
          headers: {
            "set-cookie": "koko_replay_lab=checkpoint-v1; Path=/; SameSite=Lax",
            "x-replay-lab-case": "cookie",
          },
        },
      );

    case "clock":
      return json(
        { generatedAt: new Date().toISOString(), nonce: crypto.randomUUID() },
        { headers: { "x-replay-lab-case": "clock" } },
      );

    case "live-miss":
      return json(
        { ok: true, query: Object.fromEntries(url.searchParams), note: "Use a new nonce to create an uncaptured URL." },
        { headers: { "x-replay-lab-case": "live-miss" } },
      );

    default:
      return json({ ok: false, error: "Unknown replay-lab scenario", scenario }, { status: 404 });
  }
}

export async function POST(request: Request, context: RouteContext) {
  const { scenario } = await context.params;
  if (scenario !== "echo") {
    return json({ ok: false, error: "POST is only supported by the echo scenario" }, { status: 405 });
  }

  const contentType = request.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await request.json()
    : await request.text();

  return json(
    { ok: true, method: "POST", received: body, marker: "ECHO_RESPONSE_V1" },
    { status: 201, headers: { "x-replay-lab-case": "echo" } },
  );
}
