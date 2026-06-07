/**
 * ConversationStore — Session management with TTL and size limits.
 * Fixes KG-1 (memory leak) and implements KG-6 (TTL + max-size).
 */

export interface StoreOptions {
  /** Session TTL in milliseconds. Default: 30 minutes. */
  sessionTtlMs: number;
  /** Maximum number of sessions. Default: 1000. */
  maxSessions: number;
  /** Maximum messages per session. Default: 200. */
  maxMessagesPerSession: number;
  /** Interval for periodic sweep in milliseconds. Default: 60 seconds. */
  sweepIntervalMs: number;
}

const DEFAULT_OPTIONS: StoreOptions = {
  sessionTtlMs: 30 * 60 * 1000,       // 30 minutes
  maxSessions: 1000,
  maxMessagesPerSession: 200,
  sweepIntervalMs: 60 * 1000,          // 60 seconds
};

interface Session {
  messages: any[];
  toolUseIndex: Map<string, any>;
  lastAccessedAt: number;
  createdAt: number;
}

export class ConversationStore {
  private sessions = new Map<string, Session>();
  private options: StoreOptions;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: Partial<StoreOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.startSweep();
  }

  /**
   * Get or create a session. Evicts expired sessions lazily.
   */
  getOrCreate(id: string): { messages: any[]; toolUseIndex: Map<string, any> } {
    const now = Date.now();
    const existing = this.sessions.get(id);

    if (existing) {
      if (this.isExpired(existing, now)) {
        this.sessions.delete(id);
      } else {
        existing.lastAccessedAt = now;
        return existing;
      }
    }

    // Enforce max sessions — evict oldest if at capacity
    if (this.sessions.size >= this.options.maxSessions) {
      this.evictOldest();
    }

    const session: Session = {
      messages: [],
      toolUseIndex: new Map(),
      lastAccessedAt: now,
      createdAt: now,
    };
    this.sessions.set(id, session);
    return session;
  }

  /**
   * Add a message to a session, enforcing max messages limit.
   * Trims oldest messages when limit is reached.
   */
  addMessage(id: string, message: any): void {
    const session = this.getOrCreate(id);
    session.messages.push(message);

    if (session.messages.length > this.options.maxMessagesPerSession) {
      // Remove oldest messages, keep the most recent ones
      const overflow = session.messages.length - this.options.maxMessagesPerSession;
      session.messages.splice(0, overflow);
    }
  }

  /**
   * Delete a specific session.
   */
  delete(id: string): boolean {
    return this.sessions.delete(id);
  }

  /**
   * Get current session count (for monitoring/health).
   */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Get store stats for health/debug endpoints.
   */
  stats(): { sessions: number; maxSessions: number; ttlMs: number; maxMessagesPerSession: number } {
    return {
      sessions: this.sessions.size,
      maxSessions: this.options.maxSessions,
      ttlMs: this.options.sessionTtlMs,
      maxMessagesPerSession: this.options.maxMessagesPerSession,
    };
  }

  /**
   * Stop the periodic sweep timer (for clean shutdown).
   */
  destroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.sessions.clear();
  }

  private isExpired(session: Session, now: number): boolean {
    return (now - session.lastAccessedAt) > this.options.sessionTtlMs;
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, session] of this.sessions) {
      if (session.lastAccessedAt < oldestTime) {
        oldestTime = session.lastAccessedAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.sessions.delete(oldestKey);
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (this.isExpired(session, now)) {
        this.sessions.delete(key);
      }
    }
  }

  private startSweep(): void {
    if (this.options.sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => this.sweep(), this.options.sweepIntervalMs);
      // Allow process to exit even if timer is running
      if (this.sweepTimer.unref) {
        this.sweepTimer.unref();
      }
    }
  }
}
