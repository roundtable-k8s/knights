/**
 * A small local OTLP/HTTP receiver for tests. It accepts JSON-encoded trace,
 * log and metric exports (OTEL_EXPORTER_OTLP_PROTOCOL=http/json) and keeps the
 * decoded spans and log records, so a test can assert on what a real exporter
 * (such as the Claude Code CLI) sent. No dependency beyond node:http.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";

type AnyValue = {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
  arrayValue?: { values?: AnyValue[] };
  kvlistValue?: { values?: KeyValue[] };
};
type KeyValue = { key: string; value?: AnyValue };

export interface ReceivedSpan {
  traceId: string;
  spanId: string;
  /** Empty string for a root span. */
  parentSpanId: string;
  name: string;
  attributes: Record<string, unknown>;
  resource: Record<string, unknown>;
}

export interface ReceivedLog {
  traceId: string;
  spanId: string;
  body: unknown;
  attributes: Record<string, unknown>;
  resource: Record<string, unknown>;
}

export interface OtlpReceiver {
  /** Base URL, for OTEL_EXPORTER_OTLP_ENDPOINT. */
  url: string;
  spans: ReceivedSpan[];
  logs: ReceivedLog[];
  /** Requests that were not decodable JSON (for diagnostics). */
  rejected: Array<{ path: string; contentType: string; bytes: number }>;
  /** Poll until `pred` holds or `timeoutMs` passes; returns whether it held. */
  waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean>;
  close(): Promise<void>;
}

function value(v: AnyValue | undefined): unknown {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.arrayValue) return (v.arrayValue.values ?? []).map(value);
  if (v.kvlistValue) return attrs(v.kvlistValue.values);
  return undefined;
}

function attrs(list: KeyValue[] | undefined): Record<string, unknown> {
  return Object.fromEntries((list ?? []).map((kv) => [kv.key, value(kv.value)]));
}

export async function startOtlpReceiver(): Promise<OtlpReceiver> {
  const spans: ReceivedSpan[] = [];
  const logs: ReceivedLog[] = [];
  const rejected: OtlpReceiver["rejected"] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0]!;
      const contentType = String(req.headers["content-type"] ?? "");
      let raw = Buffer.concat(chunks);
      try {
        if (req.headers["content-encoding"] === "gzip") raw = gunzipSync(raw);
        const body = JSON.parse(raw.toString("utf8"));
        if (path === "/v1/traces") {
          for (const rs of body.resourceSpans ?? []) {
            const resource = attrs(rs.resource?.attributes);
            for (const ss of rs.scopeSpans ?? []) {
              for (const s of ss.spans ?? []) {
                spans.push({ traceId: s.traceId, spanId: s.spanId, parentSpanId: s.parentSpanId ?? "", name: s.name, attributes: attrs(s.attributes), resource });
              }
            }
          }
        } else if (path === "/v1/logs") {
          for (const rl of body.resourceLogs ?? []) {
            const resource = attrs(rl.resource?.attributes);
            for (const sl of rl.scopeLogs ?? []) {
              for (const l of sl.logRecords ?? []) {
                logs.push({ traceId: l.traceId ?? "", spanId: l.spanId ?? "", body: value(l.body), attributes: attrs(l.attributes), resource });
              }
            }
          }
        }
      } catch {
        rejected.push({ path, contentType, bytes: raw.length });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    spans,
    logs,
    rejected,
    async waitFor(pred, timeoutMs) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        if (pred()) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return pred();
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
