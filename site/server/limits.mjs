// Daily limits for the public agent. Every counter starts over at midnight UTC.
// The budget bounds what the demo can ever cost in a day; the per-address
// counters keep one visitor from using all of it.
// With a state file, the day's spending and turn count survive a restart.
// Addresses stay in memory only, so no visitor address is written to disk.
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export class DailyLimits {
  constructor({ dailyBudgetUsd, sessionsPerAddress, turnsPerAddress, stateFile = null, now = () => Date.now() }) {
    this.dailyBudgetUsd = dailyBudgetUsd;
    this.sessionsPerAddress = sessionsPerAddress;
    this.turnsPerAddress = turnsPerAddress;
    this.stateFile = stateFile;
    this.now = now;
    this.day = null;
    this.roll();
    this.#restore();
    // Write once now, so an unwritable folder stops the server at startup instead of failing later.
    this.#write();
  }

  #restore() {
    if (!this.stateFile) return;
    try {
      const saved = JSON.parse(readFileSync(this.stateFile, "utf8"));
      if (saved.day !== this.day) return;
      if (Number.isFinite(saved.spentUsd) && saved.spentUsd > 0) this.spentUsd = saved.spentUsd;
      if (Number.isSafeInteger(saved.turns) && saved.turns > 0) this.turns = saved.turns;
    } catch {}
  }

  #save() {
    // A failed save keeps today's count in memory; it must not interrupt a visitor's turn.
    try { this.#write(); } catch {}
  }

  #write() {
    if (!this.stateFile) return;
    const temporary = `${this.stateFile}.tmp`;
    writeFileSync(temporary, JSON.stringify({ day: this.day, spentUsd: this.spentUsd, turns: this.turns }));
    renameSync(temporary, this.stateFile);
  }

  roll() {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (day === this.day) return;
    this.day = day;
    this.spentUsd = 0;
    this.turns = 0;
    this.addresses = new Map();
  }

  #address(address) {
    this.roll();
    let entry = this.addresses.get(address);
    if (!entry) this.addresses.set(address, entry = { sessions: 0, turns: 0 });
    return entry;
  }

  budgetLeft() {
    this.roll();
    return this.dailyBudgetUsd - this.spentUsd;
  }

  spend(usd) {
    this.roll();
    if (Number.isFinite(usd) && usd > 0) this.spentUsd += usd;
    this.#save();
  }

  claimSession(address) {
    const entry = this.#address(address);
    if (entry.sessions >= this.sessionsPerAddress) return false;
    entry.sessions += 1;
    return true;
  }

  claimTurn(address) {
    const entry = this.#address(address);
    if (entry.turns >= this.turnsPerAddress) return false;
    entry.turns += 1;
    this.turns += 1;
    this.#save();
    return true;
  }

  summary() {
    this.roll();
    return { day: this.day, spentUsd: Number(this.spentUsd.toFixed(4)), turns: this.turns, addresses: this.addresses.size };
  }
}
