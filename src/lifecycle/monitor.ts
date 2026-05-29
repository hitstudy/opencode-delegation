/**
 * Event monitoring module.
 *
 * MVP STUB — in-memory log only, no persistence, no external read interface.
 * Exists solely as a hook point for the plugin's event handler.
 *
 * Future extensions:
 * - Persist to disk for debugging across sessions
 * - Expose via MCP tool for main agent to query
 * - Background mode: monitor session lifecycle, inject results into parent
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MonitoredEvent = {
  type: string;
  timestamp: number;
  sessionId?: string;
  data?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Event logger (in-memory, capped)
// ---------------------------------------------------------------------------

const eventLog: MonitoredEvent[] = [];
const MAX_LOG_SIZE = 100;

/**
 * Record a session error event for debugging.
 */
export function recordSessionError(sessionId: string, error: unknown): void {
  const entry: MonitoredEvent = {
    type: "session.error",
    timestamp: Date.now(),
    sessionId,
    data: {
      message: error instanceof Error ? error.message : String(error),
    },
  };

  eventLog.push(entry);
  if (eventLog.length > MAX_LOG_SIZE) {
    eventLog.shift();
  }
}

/**
 * Get recent monitored events (for debugging).
 */
export function getRecentEvents(count = 10): MonitoredEvent[] {
  return eventLog.slice(-count);
}
