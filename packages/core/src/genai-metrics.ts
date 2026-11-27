import { metrics, type Histogram, type MeterProvider } from "@opentelemetry/api";

const METER_NAME = "@roundtable/knight-core";

/** Explicit bucket boundaries from the OpenTelemetry GenAI semantic conventions. */
export const DURATION_BUCKETS = [0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92];
export const TOKEN_BUCKETS = [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864];

export interface ChatTurn {
  /** Requested model. */
  model: string;
  /** Model that answered, when it differs or is known. */
  responseModel?: string;
  provider?: string;
  durationSeconds: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Set on a failed turn (`error.type`). */
  errorType?: string;
  knight: string;
  table?: string;
}

interface Instruments {
  duration: Histogram;
  tokens: Histogram;
}

let cached: { provider: MeterProvider; instruments: Instruments } | undefined;

/** Created lazily from the global meter provider; a no-op meter when none is registered (metrics off). */
function instruments(): Instruments {
  const provider = metrics.getMeterProvider();
  if (cached?.provider === provider) return cached.instruments;
  const meter = provider.getMeter(METER_NAME);
  const instruments = {
    duration: meter.createHistogram("gen_ai.client.operation.duration", {
      description: "GenAI operation duration",
      unit: "s",
      advice: { explicitBucketBoundaries: DURATION_BUCKETS },
    }),
    tokens: meter.createHistogram("gen_ai.client.token.usage", {
      description: "Number of input and output tokens used",
      unit: "{token}",
      advice: { explicitBucketBoundaries: TOKEN_BUCKETS },
    }),
  };
  cached = { provider, instruments };
  return instruments;
}

/** Record one LLM turn in the GenAI client histograms. Never throws. */
export function recordChatTurn(turn: ChatTurn): void {
  try {
    const { duration, tokens } = instruments();
    const attrs: Record<string, string> = {
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": turn.model,
      "roundtable.table": turn.table || "none",
      "roundtable.knight": turn.knight,
    };
    if (turn.responseModel) attrs["gen_ai.response.model"] = turn.responseModel;
    if (turn.provider) attrs["gen_ai.provider.name"] = turn.provider;
    if (turn.errorType) attrs["error.type"] = turn.errorType;
    duration.record(Math.max(0, turn.durationSeconds), attrs);
    // Token usage carries no error.type: semconv records it on the duration only.
    const { "error.type": _omit, ...tokenAttrs } = attrs;
    if (turn.inputTokens !== undefined) tokens.record(turn.inputTokens, { ...tokenAttrs, "gen_ai.token.type": "input" });
    if (turn.outputTokens !== undefined) tokens.record(turn.outputTokens, { ...tokenAttrs, "gen_ai.token.type": "output" });
  } catch {
    // Metrics must never fail a task.
  }
}
