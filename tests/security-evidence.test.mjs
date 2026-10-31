import test from "node:test";
import assert from "node:assert/strict";
import { analyzeSecurity } from "../src/core/security-evidence.ts";

function response(id, url, resourceType, responseBody, extra = {}) {
  return { id, sessionId: "run", sequence: 1, timestamp: 1, duration: 0, kind: "network", name: "response", status: "ok", payload: { journeyStage: "response", url, resourceType, responseBody, ...extra } };
}
const document = response("document", "https://example.test/", "Document", '<form><input name="$ACTION_ID_0123456789abcdef0123456789abcdef01234567"></form><script>self.__next_f.push([])</script>', { topLevelNavigation: true, responseHeaders: "X-Powered-By: Next.js\n" });
const script = (version, host = "example.test", appDir = "!0") => response("script", `https://${host}/_next/static/chunks/a.js`, "Script", `window.next={version:"${version}",appDir:${appDir}}`);

test("observed Next App Router version creates an evidence-linked advisory candidate", () => {
  const report = analyzeSecurity([document, script("15.0.0")]);
  assert.equal(report.fingerprints[0].version, "15.0.0");
  assert.equal(report.findings[0].advisory.id, "CVE-2025-66478");
  assert.equal(report.findings[0].state, "exposure-candidate");
  assert.ok(report.findings[0].evidence.some((item) => item.eventId === "script" && item.kind === "framework-version"));
  assert.ok(report.findings[0].evidence.some((item) => item.kind === "server-action-marker" && !item.snippet.includes("012345")));
});

test("fixed versions, Pages Router and third-party bundles do not create an exposure candidate", () => {
  for (const target of [script("15.0.5"), script("15.0.0", "example.test", "!1"), script("15.0.0", "third-party.test"), script("15.0.0-canary.1")]) {
    assert.equal(analyzeSecurity([document, target]).findings.length, 0);
  }
});

test("header alone reports technology without inventing a version or a vulnerability", () => {
  const report = analyzeSecurity([document]);
  assert.equal(report.fingerprints[0].version, undefined);
  assert.equal(report.findings.length, 0);
  assert.equal(analyzeSecurity([script("15.0.0")]).fingerprints.length, 0);
});
