export class BoundedRingBuffer<T> {
  private buffer: (T | undefined)[];
  private head = 0;
  private count = 0;
  private readonly cap: number;
  private warnedAt80 = false;

  constructor(capacity: number) {
    if (capacity < 1) {
      throw new Error(`BoundedRingBuffer capacity must be >= 1, got ${capacity}`);
    }
    this.cap = capacity;
    this.buffer = new Array(capacity);
  }

  push(item: T): void {
    this.buffer[(this.head + this.count) % this.cap] = item;

    if (this.count < this.cap) {
      this.count++;
    } else {
      this.head = (this.head + 1) % this.cap;
    }

    const utilization = this.count / this.cap;
    if (utilization > 0.8 && !this.warnedAt80) {
      this.warnedAt80 = true;
      console.warn(
        `[scrollback] ring buffer at ${Math.round(utilization * 100)}% capacity (${this.count}/${this.cap})`,
      );
    }
    if (utilization <= 0.8) {
      this.warnedAt80 = false;
    }
  }

  drain(): T[] {
    const items: T[] = [];
    for (let i = 0; i < this.count; i++) {
      items.push(this.buffer[(this.head + i) % this.cap] as T);
    }
    this.head = 0;
    this.count = 0;
    this.warnedAt80 = false;
    return items;
  }

  get size(): number {
    return this.count;
  }

  get isFull(): boolean {
    return this.count === this.cap;
  }
}
