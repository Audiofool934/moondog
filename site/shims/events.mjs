// A small EventEmitter for pi-tui's input buffer.
export class EventEmitter {
  #listeners = new Map();
  on(name, listener) { (this.#listeners.get(name) ?? this.#listeners.set(name, []).get(name)).push(listener); return this; }
  addListener(name, listener) { return this.on(name, listener); }
  once(name, listener) {
    const wrapped = (...args) => { this.off(name, wrapped); listener(...args); };
    return this.on(name, wrapped);
  }
  off(name, listener) {
    const list = this.#listeners.get(name);
    if (list) this.#listeners.set(name, list.filter((item) => item !== listener));
    return this;
  }
  removeListener(name, listener) { return this.off(name, listener); }
  removeAllListeners(name) { if (name === undefined) this.#listeners.clear(); else this.#listeners.delete(name); return this; }
  emit(name, ...args) {
    const list = this.#listeners.get(name);
    if (!list?.length) return false;
    for (const listener of [...list]) listener(...args);
    return true;
  }
  listeners(name) { return [...(this.#listeners.get(name) ?? [])]; }
}
export default EventEmitter;
