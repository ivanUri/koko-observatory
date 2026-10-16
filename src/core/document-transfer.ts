type TransferEvent = {
  kind?: string;
  payload?: Record<string, unknown>;
};

/** Core emits CDP resource types such as "Document", not "document". */
export function isDocumentResource(payload: Record<string, unknown> | undefined) {
  return String(payload?.resourceType ?? "").toLowerCase() === "document";
}

/** A document transfer is the navigation only when the request says so. */
export function matchesLockedDocument(payload: Record<string, unknown> | undefined, lockedRequestId?: string) {
  if (!isDocumentResource(payload)) return false;
  if (payload?.topLevelNavigation === false) return false;
  if (!lockedRequestId) return true;
  return String(payload?.requestId ?? "") === lockedRequestId;
}

export function lockDocumentRequest(payload: Record<string, unknown> | undefined, lockedRequestId?: string) {
  if (!isDocumentResource(payload) || payload?.requestId == null) return lockedRequestId;
  if (payload.topLevelNavigation === false) return lockedRequestId;
  if (lockedRequestId) return lockedRequestId;
  return String(payload.requestId);
}

function sameUrl(left: unknown, right: unknown) {
  if (typeof left !== "string" || typeof right !== "string" || !left || !right) return false;
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return left === right;
  }
}

function isCapturedResponse(event: TransferEvent) {
  const payload = event.payload ?? {};
  return event.kind === "network"
    && payload.journeyStage === "response"
    && payload.bodyCaptureState === "captured"
    && typeof payload.responseBody === "string";
}

function onlyOne<T>(items: T[]) {
  return items.length === 1 ? items[0] : undefined;
}

function isTopLevelNavigation(payload: Record<string, unknown> | undefined) {
  return payload?.topLevelNavigation === true;
}

/**
 * The navigation document is the top-level navigation transfer.
 * URL match breaks a tie between several top-level navigations.
 * A single captured document is used only when nothing else identifies one.
 */
export function selectDocumentResponse<T extends TransferEvent>(events: T[], requestedUrl?: string): T | undefined {
  const captured = events.filter(isCapturedResponse);
  const documents = captured.filter((event) => isDocumentResource(event.payload));
  const topLevel = documents.filter((event) => isTopLevelNavigation(event.payload));
  const matchesRequest = (event: T) => sameUrl(event.payload?.url, requestedUrl);
  return topLevel.find(matchesRequest)
    ?? onlyOne(topLevel)
    ?? documents.find(matchesRequest)
    ?? onlyOne(documents)
    ?? captured.find((event) => matchesRequest(event) && String(event.payload?.contentType ?? "").toLowerCase().includes("html"));
}
