export type Unsubscribe = () => void;

interface ListenerEntry<TPayload> {
  fn: (payload: TPayload) => void;
  once: boolean;
  active: boolean;
}

/**
 * Strongly typed publish/subscribe event bus.
 * Zero per-emit heap allocations and re-entrancy safe against unsubscribe-during-emit.
 */
export class EventBus<TEvents extends { [K in keyof TEvents]: unknown }> {
  private readonly channels = new Map<keyof TEvents, ListenerEntry<unknown>[]>();
  private emitDepth = 0;
  private needsSweep = false;

  on<K extends keyof TEvents>(
    event: K,
    listener: (payload: TEvents[K]) => void,
  ): Unsubscribe {
    return this.subscribe(event, listener, false);
  }

  once<K extends keyof TEvents>(
    event: K,
    listener: (payload: TEvents[K]) => void,
  ): Unsubscribe {
    return this.subscribe(event, listener, true);
  }

  off<K extends keyof TEvents>(
    event: K,
    listener: (payload: TEvents[K]) => void,
  ): void {
    const list = this.channels.get(event);
    if (!list) return;

    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i];
      if (entry && entry.active && entry.fn === listener) {
        if (this.emitDepth > 0) {
          entry.active = false;
          this.needsSweep = true;
        } else {
          list.splice(i, 1);
        }
      }
    }
  }

  emit<K extends keyof TEvents>(event: K, payload: TEvents[K]): void {
    const list = this.channels.get(event);
    if (!list || list.length === 0) return;

    const initialLength = list.length;
    this.emitDepth++;
    try {
      for (let i = 0; i < initialLength; i++) {
        const entry = list[i];
        if (!entry || !entry.active) continue;
        if (entry.once) {
          entry.active = false;
          this.needsSweep = true;
        }
        (entry.fn as (data: TEvents[K]) => void)(payload);
      }
    } finally {
      this.emitDepth--;
      if (this.emitDepth === 0 && this.needsSweep) {
        this.sweepInactive();
      }
    }
  }

  listenerCount(event?: keyof TEvents): number {
    if (event !== undefined) {
      const list = this.channels.get(event);
      if (!list) return 0;
      let count = 0;
      for (let i = 0; i < list.length; i++) {
        if (list[i]?.active) count++;
      }
      return count;
    }

    let total = 0;
    for (const list of this.channels.values()) {
      for (let i = 0; i < list.length; i++) {
        if (list[i]?.active) total++;
      }
    }
    return total;
  }

  clear(event?: keyof TEvents): void {
    if (event !== undefined) {
      const list = this.channels.get(event);
      if (!list) return;
      if (this.emitDepth > 0) {
        for (let i = 0; i < list.length; i++) {
          const entry = list[i];
          if (entry) entry.active = false;
        }
        this.needsSweep = true;
      } else {
        list.length = 0;
      }
      return;
    }

    if (this.emitDepth > 0) {
      for (const list of this.channels.values()) {
        for (let i = 0; i < list.length; i++) {
          const entry = list[i];
          if (entry) entry.active = false;
        }
      }
      this.needsSweep = true;
    } else {
      this.channels.clear();
    }
  }

  private subscribe<K extends keyof TEvents>(
    event: K,
    listener: (payload: TEvents[K]) => void,
    once: boolean,
  ): Unsubscribe {
    let list = this.channels.get(event);
    if (!list) {
      list = [];
      this.channels.set(event, list);
    }
    const entry: ListenerEntry<unknown> = {
      fn: listener as (payload: unknown) => void,
      once,
      active: true,
    };
    list.push(entry);

    return () => {
      if (!entry.active) return;
      entry.active = false;
      if (this.emitDepth > 0) {
        this.needsSweep = true;
      } else {
        const idx = list.indexOf(entry);
        if (idx !== -1) {
          list.splice(idx, 1);
        }
      }
    };
  }

  private sweepInactive(): void {
    this.needsSweep = false;
    for (const list of this.channels.values()) {
      let writeIdx = 0;
      for (let i = 0; i < list.length; i++) {
        const entry = list[i];
        if (entry && entry.active) {
          list[writeIdx++] = entry;
        }
      }
      list.length = writeIdx;
    }
  }
}
