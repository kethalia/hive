import type postgres from "postgres";
import { BoundedRingBuffer } from "./ring-buffer.js";

interface ScrollbackChunk {
  reconnectId: string;
  agentId: string;
  sessionName: string;
  seqNum: number;
  data: Buffer;
  byteSize: number;
}

interface ScrollbackWriterOptions {
  reconnectId: string;
  agentId: string;
  sessionName: string;
  pool: postgres.Sql;
  ringBufferCapacity?: number;
  flushIntervalMs?: number;
  sizeThreshold?: number;
}

const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const DEFAULT_SIZE_THRESHOLD = 102_400; // 100KB
const IMMEDIATE_FLUSH_THRESHOLD = 262_144; // 256KB
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export class ScrollbackWriter {
  private readonly reconnectId: string;
  private readonly agentId: string;
  private readonly sessionName: string;
  private readonly pool: postgres.Sql;
  private readonly ringBuffer: BoundedRingBuffer<ScrollbackChunk>;
  private readonly sizeThreshold: number;

  private bufferChunks: Buffer[] = [];
  private bufferBytes = 0;
  private seqNum = 0;
  private flushing = false;
  private closed = false;

  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryBackoffMs = BACKOFF_BASE_MS;

  constructor(opts: ScrollbackWriterOptions) {
    this.reconnectId = opts.reconnectId;
    this.agentId = opts.agentId;
    this.sessionName = opts.sessionName;
    this.pool = opts.pool;
    this.sizeThreshold = opts.sizeThreshold ?? DEFAULT_SIZE_THRESHOLD;
    this.ringBuffer = new BoundedRingBuffer<ScrollbackChunk>(
      opts.ringBufferCapacity ?? 256,
    );

    const intervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.flushTimer = setInterval(() => {
      if (this.bufferBytes > 0) {
        this.scheduleFlush();
      }
    }, intervalMs);
  }

  append(data: Buffer): void {
    if (this.closed) return;
    this.bufferChunks.push(data);
    this.bufferBytes += data.length;

    if (data.length >= IMMEDIATE_FLUSH_THRESHOLD || this.bufferBytes >= this.sizeThreshold) {
      this.scheduleFlush();
    }
  }

  private scheduleFlush(): void {
    if (this.flushing) return;
    this.flush().catch(() => {});
  }

  async flush(): Promise<void> {
    if (this.bufferBytes === 0) return;
    if (this.flushing) return;
    this.flushing = true;

    try {
      const data = Buffer.concat(this.bufferChunks);
      const byteSize = data.length;
      const seqNum = this.seqNum++;
      this.bufferChunks = [];
      this.bufferBytes = 0;

      const chunk: ScrollbackChunk = {
        reconnectId: this.reconnectId,
        agentId: this.agentId,
        sessionName: this.sessionName,
        seqNum,
        data,
        byteSize,
      };

      await this.insertChunk(chunk);
      console.log(
        `[scrollback] flushed seqNum=${seqNum} bytes=${byteSize} reconnectId=${this.reconnectId}`,
      );
    } catch (err) {
      // already handled inside insertChunk — ring buffer push + retry start
    } finally {
      this.flushing = false;
    }
  }

  private async insertChunk(chunk: ScrollbackChunk): Promise<void> {
    try {
      await this.pool`
        INSERT INTO scrollback_chunks (reconnect_id, agent_id, session_name, seq_num, data, byte_size)
        VALUES (${chunk.reconnectId}, ${chunk.agentId}, ${chunk.sessionName}, ${chunk.seqNum}, ${chunk.data}, ${chunk.byteSize})
      `;
    } catch (err) {
      console.error(
        `[scrollback] flush failed seqNum=${chunk.seqNum} reconnectId=${this.reconnectId}:`,
        (err as Error).message,
      );
      this.ringBuffer.push(chunk);
      this.startRetryLoop();
      throw err;
    }
  }

  private startRetryLoop(): void {
    if (this.retryTimer !== null) return;
    this.retryTick();
  }

  private retryTick(): void {
    if (this.closed && this.ringBuffer.size === 0) return;

    this.retryTimer = setTimeout(async () => {
      const chunks = this.ringBuffer.drain();
      if (chunks.length === 0) {
        this.retryTimer = null;
        this.retryBackoffMs = BACKOFF_BASE_MS;
        return;
      }

      try {
        for (const chunk of chunks) {
          await this.pool`
            INSERT INTO scrollback_chunks (reconnect_id, agent_id, session_name, seq_num, data, byte_size)
            VALUES (${chunk.reconnectId}, ${chunk.agentId}, ${chunk.sessionName}, ${chunk.seqNum}, ${chunk.data}, ${chunk.byteSize})
          `;
        }
        console.log(
          `[scrollback] drained ${chunks.length} chunks from ring buffer reconnectId=${this.reconnectId}`,
        );
        this.retryBackoffMs = BACKOFF_BASE_MS;
        if (this.ringBuffer.size === 0) {
          this.retryTimer = null;
          return;
        }
      } catch (err) {
        console.error(
          `[scrollback] retry drain failed reconnectId=${this.reconnectId}:`,
          (err as Error).message,
        );
        for (const chunk of chunks) {
          this.ringBuffer.push(chunk);
        }
        this.retryBackoffMs = Math.min(this.retryBackoffMs * 2, BACKOFF_MAX_MS);
      }

      this.retryTick();
    }, this.retryBackoffMs);
  }

  async close(): Promise<void> {
    this.closed = true;

    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    this.flushing = false;
    await this.flush();

    const remaining = this.ringBuffer.drain();
    if (remaining.length > 0) {
      try {
        for (const chunk of remaining) {
          await this.pool`
            INSERT INTO scrollback_chunks (reconnect_id, agent_id, session_name, seq_num, data, byte_size)
            VALUES (${chunk.reconnectId}, ${chunk.agentId}, ${chunk.sessionName}, ${chunk.seqNum}, ${chunk.data}, ${chunk.byteSize})
          `;
        }
        console.log(
          `[scrollback] close drained ${remaining.length} chunks from ring buffer reconnectId=${this.reconnectId}`,
        );
      } catch (err) {
        console.warn(
          `[scrollback] data loss: ${remaining.length} chunks remain in ring buffer after close reconnectId=${this.reconnectId}`,
        );
      }
    }
  }
}
