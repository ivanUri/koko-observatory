import assert from "node:assert/strict";
import test from "node:test";
import { aggregateNetworkRequests, groupNetworkTransfers, matchesNetworkType, resolveTransferSizes } from "../src/core/network-metrics.ts";

function event(sequence, stage, duration, overrides = {}) {
  return {
    id: `event-${sequence}`,
    sessionId: "session",
    sequence,
    timestamp: 1_000 + sequence,
    duration,
    kind: "network",
    name: stage,
    status: "ok",
    payload: { executionId: "execution", journeyStage: stage, requestId: 1, url: "https://example.com/data", measurement: duration ? "measured" : "boundary", ...overrides },
  };
}

test("aggregates one transfer and excludes boundary/error durations", () => {
  const transfers = groupNetworkTransfers([
    event(1, "queue", 2),
    event(2, "request", 5),
    event(3, "response", 7),
    { ...event(4, "server", 99, { measurement: "measured" }), status: "error" },
    event(5, "received", 0, { measurement: "boundary" }),
  ]);
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].duration, 14);
});

test("keeps concurrent same-URL request IDs as separate transfers", () => {
  const transfers = groupNetworkTransfers([
    event(1, "queue", 1, { requestId: 10 }),
    event(2, "response", 3, { requestId: 10 }),
    event(3, "queue", 2, { requestId: 11 }),
    event(4, "response", 4, { requestId: 11 }),
  ]);
  assert.deepEqual(transfers.map((transfer) => transfer.duration), [4, 6]);
  assert.deepEqual(transfers.map((transfer) => transfer.requestId), ["10", "11"]);
});

function transfer(requestId, payload, stages = ["queue", "response"]) {
  return stages.map((stage, index) => ({
    id: `${requestId}-${stage}`,
    sessionId: "session",
    sequence: requestId * 10 + index,
    timestamp: 1_000 + requestId,
    duration: stage === "queue" ? 2 : 5,
    kind: "network",
    name: stage,
    status: payload.status ?? "ok",
    payload: {
      executionId: "execution",
      journeyStage: stage,
      requestId,
      url: "https://example.com/data",
      measurement: "measured",
      terminalStatus: "ok",
      method: "GET",
      ...payload,
      status: undefined,
    },
  }));
}

test("counts HTTP error statuses separately from transport failure", () => {
  const requests = aggregateNetworkRequests([
    ...transfer(1, { responseStatus: 200, resourceType: "Document" }),
    ...transfer(2, { responseStatus: 404, resourceType: "Ping", method: "POST", url: "https://example.com/ajax/qm/" }),
    ...transfer(3, { responseStatus: 400, resourceType: "Document", url: "https://example.com/unsupportedbrowser" }),
    ...transfer(4, { responseStatus: 0, terminalStatus: "error", status: "error", resourceType: "Script" }),
    ...transfer(5, { responseStatus: 304, resourceType: "Document", cacheDecision: "revalidated" }),
  ]);
  const byId = Object.fromEntries(requests.map((request) => [request.requestId, request]));
  assert.equal(byId[1].failed, false);
  assert.equal(byId[2].failed, true);
  assert.equal(byId[2].transportFailed, false);
  assert.equal(byId[2].httpError, true);
  assert.equal(byId[3].httpError, true);
  assert.equal(byId[4].transportFailed, true);
  assert.equal(byId[4].terminalStatus, "error");
  assert.equal(byId[5].failed, false);
});

test("does not treat a non-GET Ping as Fetch/XHR", () => {
  const ping = { resourceType: "Ping", contentType: "text/plain", url: "https://example.com/ajax/qm/", method: "POST" };
  const xhr = { resourceType: "XHR", contentType: "application/json", url: "https://example.com/api", method: "POST" };
  const document = { resourceType: "Document", contentType: "text/html", url: "https://example.com/", method: "GET" };
  assert.equal(matchesNetworkType("xhr", ping), false);
  assert.equal(matchesNetworkType("xhr", xhr), true);
  assert.equal(matchesNetworkType("xhr", document), false);
  assert.equal(matchesNetworkType("doc", document), true);
});

test("keeps transferred bytes separate from the decoded body", () => {
  const legacy = resolveTransferSizes({
    transferredBytes: 334,
    uncompressedBytes: 334,
    responseMemoryState: "estimated_from_transfer_size",
    responseBody: "é".repeat(200),
    bodyTruncated: false,
    contentEncoding: "br",
  });
  assert.equal(legacy.transferredBytes, 334);
  assert.equal(legacy.decodedBytes, new TextEncoder().encode("é".repeat(200)).byteLength);

  const measured = resolveTransferSizes({
    transferredBytes: 334,
    uncompressedBytes: 577,
    responseMemoryState: "decoded_body",
    responseBody: "partial",
    bodyTruncated: true,
    contentEncoding: "br",
  });
  assert.equal(measured.decodedBytes, 577);

  const hidden = resolveTransferSizes({
    transferredBytes: 82_266,
    uncompressedBytes: 82_266,
    responseMemoryState: "estimated_from_transfer_size",
    bodyTruncated: false,
    contentEncoding: "zstd",
  });
  assert.equal(hidden.decodedBytes, undefined);

  const skipped = resolveTransferSizes({ transferredBytes: 1_200, responseMemoryState: "body_not_retained" });
  assert.equal(skipped.decodedBytes, undefined);
  assert.equal(skipped.transferredBytes, 1_200);
});

test("ignores a missing connection id and reads cache headers by name", () => {
  const [request] = aggregateNetworkRequests(transfer(8, {
    responseStatus: 200,
    resourceType: "Document",
    connectionId: -1,
    connectionReused: false,
    cacheDecision: "not-observed",
    contentEncoding: "br",
    responseBodyBytes: 334,
    uncompressedSizeBytes: 334,
    responseMemoryState: "estimated_from_transfer_size",
    responseBody: "<html></html>",
    responseHeaders: "content-type: text/html\ncf-cache-status: HIT\ncache-control: max-age=60\nage: 12\nx-request-id: abc\n",
  }));
  assert.equal(request.connectionId, undefined);
  assert.equal(request.connectionReused, "no");
  assert.equal(request.cacheDecision, "not-observed");
  assert.match(request.cacheHeaders, /cf-cache-status: HIT/);
  assert.match(request.cacheHeaders, /cache-control: max-age=60/);
  assert.match(request.cacheHeaders, /age: 12/);
  assert.doesNotMatch(request.cacheHeaders, /x-request-id/);
  assert.equal(request.decodedBytes, "<html></html>".length);
  assert.equal(request.transferredBytes, 334);
});
