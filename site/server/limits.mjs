// Daily limits for the public agent. Every counter starts over at midnight UTC.
// The budget bounds what the demo can ever cost in a day; the per-address
// counters keep one visitor from using all of it.
export class DailyLimits {
  constructor({ dailyBudgetUsd, sessionsPerAddress, turnsPerAddress, now = () => Date.now() }) {
    this.dailyBudgetUsd = dailyBudgetUsd;
    this.sessionsPerAddress = sessionsPerAddress;
    this.turnsPerAddress = turnsPerAddress;
    this.now = now;
    this.day = null;
    this.roll();
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
    return true;
  }

  summary() {
    this.roll();
    return { day: this.day, spentUsd: Number(this.spentUsd.toFixed(4)), turns: this.turns, addresses: this.addresses.size };
  }
}
