import type { JourneyEdge, JourneyNode } from "./types";

const step = (
  id: string, type: JourneyNode["type"], title: string, description: string,
  duration: number, summary: JourneyNode["metadata"]["summary"], reference: string,
  raw?: string, measurement: JourneyNode["metadata"]["measurement"] = "unavailable",
): JourneyNode => ({
  id, type, title, description, duration: 0, timestamp: 0, status: "pending",
  metadata: {
    summary: summary.map((item) => ({ ...item, value: "Awaiting Koko telemetry" })), reference, raw: undefined, estimated: true, measurement,
    explanation: description,
    issues: ["Timeouts, invalid configuration, and stale cached data can interrupt this stage."],
    practices: ["Measure this stage separately and preserve protocol-level diagnostics."],
  },
});

export const internetJourneyNodes: JourneyNode[] = [
  step("url-input", "url", "URL input", "The user enters an absolute URL.", 0, [
    { label: "Protocol", value: "https" }, { label: "Hostname", value: "example.com" },
    { label: "Port", value: "443" }, { label: "Path", value: "/products" },
    { label: "Query", value: "id=5" }, { label: "Fragment", value: "info" },
  ], "WHATWG URL Standard", undefined, "not-timed"),
  step("url-parse", "url", "URL parsing", "The browser normalizes the URL and selects the default HTTPS port.", 1, [
    { label: "Absolute URL", value: "true" }, { label: "Origin", value: "https://example.com" },
  ], "WHATWG URL Standard", undefined, "not-timed"),
  step("queue", "http", "Request queue", "The request waits for network scheduling and an available connection slot.", 0, [
    { label: "Queue time", value: "Awaiting Koko telemetry" },
  ], "libcurl CURLINFO_QUEUE_TIME_T"),
  step("cache", "response", "Cache decision", "The browser decides whether to serve, revalidate, or fetch the resource from the network.", 0, [
    { label: "Decision", value: "Awaiting Koko telemetry" },
  ], "RFC 9111", undefined, "not-timed"),
  step("dns", "dns", "DNS resolution", "Caches, resolver, root, TLD and authoritative DNS resolve the host.", 4, [
    { label: "A", value: "93.184.216.34" }, { label: "AAAA", value: "2606:2800:220:1:248:1893:25c8:1946" },
    { label: "TTL", value: "300s" }, { label: "CNAME", value: "—" },
  ], "RFC 1034 · RFC 1035", "example.com. 300 IN A 93.184.216.34"),
  step("routing", "routing", "Internet routing", "Network routes carry packets between the client, proxy or origin; individual hops are not exposed by libcurl.", 0, [
    { label: "Route hops", value: "Unavailable without traceroute" },
  ], "RFC 4271"),
  step("proxy", "routing", "Proxy / tunnel", "An HTTP proxy or CONNECT tunnel may mediate the connection when configured.", 0, [
    { label: "Proxy", value: "Awaiting Koko telemetry" },
  ], "RFC 9110", undefined, "not-timed"),
  step("tcp", "connection", "TCP connection", "SYN → SYN ACK → ACK establishes a reliable connection.", 18, [
    { label: "RTT", value: "18 ms" }, { label: "Retransmissions", value: "0" }, { label: "Congestion window", value: "10 MSS" },
  ], "RFC 9293"),
  step("tls", "tls", "TLS handshake", "Client Hello, certificate validation and key exchange create encryption.", 41, [
    { label: "Version", value: "TLS 1.3" }, { label: "Cipher", value: "AES_128_GCM_SHA256" },
    { label: "Issuer", value: "DigiCert" }, { label: "Expires", value: "2027-01-15" },
  ], "RFC 8446", "TLSv1.3 / TLS_AES_128_GCM_SHA256"),
  step("request", "http", "HTTP request", "The browser sends method, headers, cookies and optional body.", 2, [
    { label: "Method", value: "GET" }, { label: "Compression", value: "br, gzip" }, { label: "Request size", value: "842 B" },
  ], "RFC 9110 · RFC 9112", "GET /products?id=5 HTTP/1.1\nHost: example.com\nAccept: text/html\nAccept-Encoding: br, gzip\nCookie: session=••••"),
  step("redirect", "http", "Redirect chain", "HTTP redirects can change the URL and method before the terminal response.", 0, [
    { label: "Redirects", value: "Awaiting Koko telemetry" },
  ], "RFC 9110", undefined, "not-timed"),
  step("server", "server", "Server / TTFB", "Measured time until the first response byte. Internal application and database timings are not exposed by the browser.", 95, [
    { label: "Measurement", value: "time to first byte" }, { label: "Application", value: "Unavailable from browser" }, { label: "Database", value: "Unavailable from browser" },
  ], "Server implementation specific"),
  step("response", "response", "HTTP response", "Status, headers and compressed response body return to the browser.", 12, [
    { label: "Status", value: "200 OK" }, { label: "Content-Type", value: "text/html; charset=utf-8" },
    { label: "Body size", value: "24.8 KB" }, { label: "Cache-Control", value: "max-age=300" },
  ], "RFC 9110", "HTTP/1.1 200 OK\nContent-Type: text/html; charset=utf-8\nContent-Encoding: br\nCache-Control: max-age=300\nContent-Length: 25395"),
  step("received", "boundary", "Browser receives response", "The Internet Journey ends here. Client-side parsing belongs to Browser Journey.", 0, [
    { label: "Received", value: "170 ms" }, { label: "Next", value: "Browser Journey" },
  ], "Boundary: Internet Journey → Browser Journey", undefined, "boundary"),
];

export const internetJourneyEdges: JourneyEdge[] = internetJourneyNodes.slice(1).map((node, index) => ({
  id: `edge-${internetJourneyNodes[index].id}-${node.id}`,
  source: internetJourneyNodes[index].id,
  target: node.id,
}));
