import assert from "node:assert/strict";
import test from "node:test";
import { isDocumentResource, lockDocumentRequest, matchesLockedDocument, selectDocumentResponse } from "../src/core/document-transfer.ts";

function response(sequence, resourceType, requestId, url, body, status = 200, extra = {}) {
  return {
    id: `event-${sequence}`,
    kind: "network",
    payload: {
      journeyStage: "response",
      resourceType,
      requestId,
      url,
      responseStatus: status,
      bodyCaptureState: "captured",
      responseBody: body,
      contentType: "text/html",
      ...extra,
    },
  };
}

test("recognizes Core's capitalized document resource type", () => {
  assert.equal(isDocumentResource({ resourceType: "Document" }), true);
  assert.equal(isDocumentResource({ resourceType: "Image" }), false);
  assert.equal(isDocumentResource({ resourceType: "Fetch" }), false);
});

test("locks the first document request and rejects later documents and subresources", () => {
  const navigation = { resourceType: "Document", requestId: 7, url: "https://example.com/" };
  const image = { resourceType: "Image", requestId: 8, url: "https://cdn.example/a.png" };
  const frame = { resourceType: "Document", requestId: 9, url: "https://example.com/frame.html" };
  const locked = lockDocumentRequest(navigation, undefined);
  assert.equal(locked, "7");
  assert.equal(lockDocumentRequest(image, locked), "7");
  assert.equal(lockDocumentRequest(frame, locked), "7");
  assert.equal(matchesLockedDocument(navigation, locked), true);
  assert.equal(matchesLockedDocument(image, locked), false);
  assert.equal(matchesLockedDocument(frame, locked), false);
});

test("an embedded document does not take the navigation lock from the top-level request", () => {
  const frame = { resourceType: "Document", requestId: 9, url: "https://example.com/frame.html", topLevelNavigation: false };
  const navigation = { resourceType: "Document", requestId: 7, url: "https://example.com/", topLevelNavigation: true };
  assert.equal(lockDocumentRequest(frame, undefined), undefined);
  assert.equal(matchesLockedDocument(frame, undefined), false);
  const locked = lockDocumentRequest(navigation, undefined);
  assert.equal(locked, "7");
  assert.equal(lockDocumentRequest(frame, locked), "7");
  assert.equal(matchesLockedDocument(navigation, locked), true);
  assert.equal(matchesLockedDocument(frame, locked), false);
});

test("site export selects the navigation document instead of a later html response", () => {
  const selected = selectDocumentResponse([
    response(1, "Document", 1, "https://example.com/", "<html>home</html>"),
    response(2, "Document", 2, "https://ads.example/frame", "<html>ad</html>"),
    response(3, "Fetch", 3, "https://example.com/widget", "<html>widget</html>", 204),
  ], "https://example.com/");
  assert.equal(selected.payload.url, "https://example.com/");
  assert.equal(selected.payload.responseBody, "<html>home</html>");
});

test("site export keeps the top-level document when an iframe response arrives first", () => {
  const selected = selectDocumentResponse([
    response(1, "Document", 9, "https://example.com/frame.html", "<html>frame</html>", 200, { topLevelNavigation: false }),
    response(2, "Document", 7, "https://example.com/final", "<html>home</html>", 200, { topLevelNavigation: true }),
  ], "http://example.com/");
  assert.equal(selected.payload.responseBody, "<html>home</html>");
});

test("site export does not guess among several unmarked documents", () => {
  const selected = selectDocumentResponse([
    response(1, "Document", 9, "https://example.com/frame.html", "<html>frame</html>"),
    response(2, "Document", 7, "https://example.com/final", "<html>home</html>"),
  ], "http://example.com/");
  assert.equal(selected, undefined);
});
