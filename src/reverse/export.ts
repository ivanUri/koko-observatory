import type { ReverseTrace } from "./types.ts";

export function downloadReverseTrace(trace: ReverseTrace, format: "json" | "markdown") {
  const content = format === "json" ? JSON.stringify(trace, null, 2) : reverseMarkdown(trace);
  const mime = format === "json" ? "application/json;charset=utf-8" : "text/markdown;charset=utf-8";
  const href = URL.createObjectURL(new Blob([content], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = `koko-reverse-${trace.sessionId || "trace"}.${format === "json" ? "json" : "md"}`;
  anchor.click();
  URL.revokeObjectURL(href);
}

export function reverseMarkdown(trace: ReverseTrace) {
  const lines = [
    "# Koko Reverse Inspector report",
    "",
    `- Schema: ${trace.schemaVersion}`,
    `- Session: ${trace.sessionId || "unknown"}`,
    `- URL: ${trace.requestedUrl || "unknown"}`,
    `- Evidence: ${trace.evidence.length}`,
    `- Nodes / edges: ${trace.nodes.length} / ${trace.edges.length}`,
    "",
    "## Evidence",
    "",
    "| Class | Kind | Action | Verification |",
    "| --- | --- | --- | --- |",
    ...trace.evidence.map((item) => `| ${item.evidenceClass} | ${item.kind} | ${item.actionId} | ${item.verificationStatus} |`),
    "",
    "## Graph edges",
    "",
    "| Relation | Source | Target | Class | Confidence |",
    "| --- | --- | --- | --- | --- |",
    ...trace.edges.map((edge) => `| ${edge.relation} | ${edge.source} | ${edge.target} | ${edge.evidenceClass} | ${edge.confidence ?? "—"} |`),
    "",
    "## Limitations",
    "",
    ...trace.limitations.map((item) => `- ${item}`),
    "",
  ];
  return lines.join("\n");
}
