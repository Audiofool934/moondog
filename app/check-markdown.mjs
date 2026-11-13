// Run with MOONDOG_HARNESS_STATES=empty MOONDOG_HARNESS_EVAL=check-markdown.mjs npm run harness.
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const wait = () => new Promise((resolve) => setTimeout(resolve, 100));
const send = window.__harness.send;
const showReply = async (text) => {
  send({ type: "session", current: "markdown-test", transcript: [{ role: "assistant", text }] });
  await wait();
  return document.querySelector(".reply .text");
};
let sample = await showReply("Left | Middle | Right\n:--- | :---: | ---:\nA\\|B | `C\\|D` | [link](https://example.com)\nshort | row\n<img src=x onerror=alert(1)> | safe | cell | ignored\n\nAfter");
assert(sample.querySelectorAll("th").length === 3, "Outer pipes should be optional");
assert([...sample.querySelectorAll("th")].map((cell) => cell.style.textAlign).join() === "left,center,right", "Columns should retain alignment");
assert(sample.querySelector("td").textContent === "A|B" && sample.querySelector("td code").textContent === "C|D", "Escaped pipes should stay in their cells");
assert(sample.querySelector("td a")?.href === "https://example.com/", "Cells should render links");
assert(sample.querySelectorAll("tbody tr")[1].children[2].textContent === "", "Short rows should have empty cells");
assert(sample.querySelectorAll("tbody tr")[2].children.length === 3 && !sample.querySelector("img"), "Extra cells should be ignored and HTML should remain text");
sample = await showReply("A | B\n--- | invalid\nC | D");
assert(!sample.querySelector("table"), "Ordinary pipes should remain text without a valid delimiter row");
send({ type: "session", current: "markdown-test", transcript: [] });
send({ type: "turn", state: "start", id: "table-stream", text: "Compare", session: "markdown-test" });
for (const delta of ["Before\n\n| A | B |\n", "|---|---|\n| one |", " two |\n\nAfter"]) {
  send({ type: "text", id: "table-stream", delta, session: "markdown-test" });
  await wait();
}
assert(document.querySelector(".reply td:last-child")?.textContent === "two", "Streamed table cells should update as text arrives");
send({ type: "turn", state: "end", id: "table-stream", status: "complete", session: "markdown-test" });
const source = `《银翼杀手》是前作，《银翼杀手 2049》是三十年后的续篇。

| | 《银翼杀手》 | 《银翼杀手 2049》 |
|---|---|---|
| 上映年份 | 1982 | 2017 |
| 导演 | 雷德利·斯科特 | 丹尼斯·维伦纽瓦 |
| 故事时间 | 2019 年的洛杉矶 | 2049 年的洛杉矶 |
| 主角 | 哈里森·福特饰演的戴克 | 瑞恩·高斯林饰演的 K，戴克也会出现 |
| 配乐 | **Vangelis** | **Hans Zimmer、Benjamin Wallfisch** |`;
window.__harness.send({ type: "session", current: "markdown-test", transcript: [
  { role: "user", text: "银翼杀手和银翼杀手2049？" },
  { role: "assistant", text: source },
] });
await wait();
const host = document.querySelector(".reply .text");
assert(host?.querySelectorAll("thead th").length === 3, "The reply should render three table headers, including the empty first cell");
assert(host.querySelectorAll("tbody tr").length === 5, "The reply should render five comparison rows");
assert(host.querySelectorAll("td strong").length === 2, "Table cells should retain emphasis");
assert(host.scrollWidth <= host.clientWidth + 1, "The table must not widen the conversation");
