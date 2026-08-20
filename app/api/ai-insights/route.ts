type ProviderMode = "responses" | "chat-completions";

type AIRequest = {
  endpoint?: unknown;
  apiKey?: unknown;
  model?: unknown;
  mode?: unknown;
  system?: unknown;
  prompt?: unknown;
};

const noStoreHeaders = { "cache-control": "no-store" };

export async function POST(request: Request) {
  let input: AIRequest;
  try {
    input = await request.json() as AIRequest;
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400, headers: noStoreHeaders });
  }

  const endpoint = text(input.endpoint, 2_048);
  const apiKey = text(input.apiKey, 4_096);
  const model = text(input.model, 256);
  const system = text(input.system, 12_000);
  const prompt = text(input.prompt, 60_000);
  const mode: ProviderMode = input.mode === "chat-completions" ? "chat-completions" : "responses";
  if (!endpoint || !model || !prompt) {
    return Response.json({ error: "Endpoint, model and prompt are required." }, { status: 400, headers: noStoreHeaders });
  }

  let target: URL;
  try {
    target = new URL(endpoint);
    if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) throw new Error("invalid endpoint");
  } catch {
    return Response.json({ error: "Endpoint must be a valid HTTP(S) URL without embedded credentials." }, { status: 400, headers: noStoreHeaders });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const upstream = await fetch(target, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: { ...(apiKey ? { "authorization": `Bearer ${apiKey}` } : {}), "content-type": "application/json" },
      body: JSON.stringify(mode === "responses"
        ? { model, instructions: system, input: prompt, max_output_tokens: 1_200 }
        : { model, messages: [{ role: "system", content: system }, { role: "user", content: prompt }], max_tokens: 1_200 }),
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      return Response.json({ error: `The AI endpoint attempted an HTTP redirect (${upstream.status}). Enter the final API endpoint URL directly.` }, { status: 502, headers: noStoreHeaders });
    }
    const raw = await upstream.text();
    let data: unknown;
    try { data = JSON.parse(raw); } catch { data = undefined; }
    if (!upstream.ok) {
      return Response.json({ error: providerError(data) || raw.slice(0, 600) || `Provider returned HTTP ${upstream.status}.`, status: upstream.status }, { status: 502, headers: noStoreHeaders });
    }
    const answer = extractAnswer(data, mode);
    if (!answer) return Response.json({ error: "The provider returned no text output." }, { status: 502, headers: noStoreHeaders });
    return Response.json({ answer, usage: record(data)?.usage ?? null }, { headers: noStoreHeaders });
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError"
      ? "The provider request timed out after 60 seconds."
      : error instanceof Error ? error.message : "Unable to reach the AI provider.";
    return Response.json({ error: message }, { status: 502, headers: noStoreHeaders });
  } finally {
    clearTimeout(timeout);
  }
}

function extractAnswer(value: unknown, mode: ProviderMode) {
  const data = record(value);
  if (mode === "chat-completions") {
    const choice = Array.isArray(data?.choices) ? record(data.choices[0]) : undefined;
    const message = record(choice?.message);
    if (typeof message?.content === "string") return message.content.trim();
    if (Array.isArray(message?.content)) return message.content.map((item) => record(item)?.text).filter((item): item is string => typeof item === "string").join("\n").trim();
    return "";
  }
  if (typeof data?.output_text === "string") return data.output_text.trim();
  if (!Array.isArray(data?.output)) return "";
  return data.output.flatMap((item) => {
    const content = record(item)?.content;
    return Array.isArray(content) ? content.flatMap((part) => typeof record(part)?.text === "string" ? [String(record(part)?.text)] : []) : [];
  }).join("\n").trim();
}

function providerError(value: unknown) {
  const error = record(record(value)?.error);
  return typeof error?.message === "string" ? error.message : "";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}
