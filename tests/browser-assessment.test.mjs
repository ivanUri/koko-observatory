import assert from "node:assert/strict";
import test from "node:test";
import { assessBrowserRuntime, combinePageLoadAssessments } from "../src/journeys/browser/assessment.ts";

function event(id, overrides = {}) {
  return {
    id,
    sessionId: "session-a",
    sequence: 1,
    timestamp: 1_000,
    duration: 5,
    kind: "javascript",
    name: "script",
    status: "ok",
    payload: { browserStage: "javascript", measurementState: "measured", ...overrides.payload },
    ...overrides,
  };
}

test("Browser Journey reports a measured runtime finding with evidence", () => {
  const assessment = assessBrowserRuntime([event("js-1", { duration: 350 })]);
  assert.equal(assessment.state, "attention");
  assert.equal(assessment.evidenceId, "js-1");
  assert.equal(assessment.headline, "Long javascript stage observed");
});

test("Browser Journey reports runtime errors instead of guessing a cause", () => {
  const assessment = assessBrowserRuntime([event("js-error", { status: "error", payload: { browserStage: "javascript", errorMessage: "boom" } })]);
  assert.equal(assessment.state, "attention");
  assert.equal(assessment.evidenceId, "js-error");
  assert.match(assessment.headline, /runtime error/);
});

test("Browser Journey stays incomplete when only transport evidence exists", () => {
  const assessment = assessBrowserRuntime([event("response", { kind: "network", name: "response", payload: { journeyStage: "response", browserStage: undefined }, duration: 20 })]);
  assert.equal(assessment.state, "incomplete");
  assert.equal(assessment.measuredCount, 0);
});

test("page-load assessment keeps transport and browser evidence distinct", () => {
  const transport = { state: "healthy", headline: "Document transport within diagnostic budgets", summary: "transport" };
  const browser = { state: "attention", headline: "Long javascript stage observed", summary: "runtime", evidenceId: "js-1", measuredCount: 1 };
  const assessment = combinePageLoadAssessments(transport, browser);
  assert.equal(assessment.state, "attention");
  assert.equal(assessment.primary, "browser");
  assert.equal(assessment.evidenceId, "js-1");
  assert.match(assessment.summary, /transport completed/);
});
