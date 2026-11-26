// Knight pods set OTEL_* variables (OTEL_SDK_DISABLED=true when telemetry is off), and the
// NodeSDK reads process.env itself. Tests that start telemetry clear them first and restore the
// ambient values afterwards, so they pass whatever the surrounding environment sets.

/** Clear every OTEL_* variable; returns a function that restores the ambient values. */
export function isolateOtelEnv(): () => void {
  const ambient = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("OTEL_")));
  const clear = (): void => {
    for (const k of Object.keys(process.env)) if (k.startsWith("OTEL_")) delete process.env[k];
  };
  clear();
  return () => {
    clear();
    Object.assign(process.env, ambient);
  };
}

/** Run fn with OTEL_* cleared from process.env, restoring the ambient values afterwards. */
export async function withCleanOtelEnv<T>(fn: () => Promise<T> | T): Promise<T> {
  const restore = isolateOtelEnv();
  try {
    return await fn();
  } finally {
    restore();
  }
}
