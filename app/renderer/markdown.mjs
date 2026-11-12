// Moondog's replies in the window: paragraphs, lists, tables, short headings, emphasis, code and links.
// Everything becomes DOM nodes with text content, so a reply can never inject markup.
// A backslash before a Markdown character shows the character, as the core escapes source titles.
const INLINE = /(\\[\\`*_[\]<>]|\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\*[^*\n]+\*|_[^_\n]+_|\[(?:\\.|[^\]\\\n])+\]\(<?https?:\/\/[^\s)>]+>?\)|<https?:\/\/[^\s>]+>|https?:\/\/[^\s<>()]+[^\s<>().,;:!?，。！？；：）」』》])/u;

function link(href, label) {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.textContent = label;
  return anchor;
}

function inline(text, parent) {
  let rest = text;
  while (rest) {
    const match = rest.match(INLINE);
    if (!match) { parent.append(rest); return; }
    if (match.index) parent.append(rest.slice(0, match.index));
    const token = match[0];
    if (token.startsWith("\\")) {
      parent.append(token.slice(1));
    } else if (token.startsWith("**") || token.startsWith("__")) {
      const strong = document.createElement("strong");
      inline(token.slice(2, -2), strong);
      parent.append(strong);
    } else if (token.startsWith("`")) {
      const code = document.createElement("code");
      code.textContent = token.slice(1, -1);
      parent.append(code);
    } else if (token.startsWith("*") || token.startsWith("_")) {
      const em = document.createElement("em");
      inline(token.slice(1, -1), em);
      parent.append(em);
    } else if (token.startsWith("[")) {
      const [, label, href] = token.match(/^\[((?:\\.|[^\]\\])+)\]\(<?(https?:\/\/[^\s)>]+)>?\)$/u);
      parent.append(link(href, label.replace(/\\(.)/gu, "$1")));
    } else {
      const href = token.replace(/^<|>$/gu, "");
      parent.append(link(href, href));
    }
    rest = rest.slice(match.index + token.length);
  }
}

// Split only unescaped pipes. Keep other escapes for the inline renderer.
function tableCells(line) {
  const cells = [""];
  let separators = 0;
  for (let at = 0; at < line.length; at += 1) {
    const char = line[at];
    if (char === "\\" && at + 1 < line.length) {
      const next = line[++at];
      cells[cells.length - 1] += next === "|" ? "|" : `\\${next}`;
    } else if (char === "|") {
      cells.push("");
      separators += 1;
    } else cells[cells.length - 1] += char;
  }
  if (!separators) return null;
  if (!cells[0].trim()) cells.shift();
  if (!cells.at(-1).trim()) cells.pop();
  return cells.map((cell) => cell.trim());
}

export function renderMarkdown(source) {
  const fragment = document.createDocumentFragment();
  const lines = String(source ?? "").replace(/\r\n?/gu, "\n").split("\n");
  let paragraph = [];
  let list = null;
  let quote = [];
  // Consecutive lines become one paragraph with line breaks, or one quotation for lines that start with ">".
  const breakLines = (target, rows) => rows.forEach((line, index) => {
    if (index) target.append(document.createElement("br"));
    inline(line, target);
  });
  const flush = () => {
    if (paragraph.length) {
      const p = document.createElement("p");
      breakLines(p, paragraph);
      fragment.append(p);
      paragraph = [];
    }
    if (quote.length) {
      const blockquote = document.createElement("blockquote");
      breakLines(blockquote, quote);
      fragment.append(blockquote);
      quote = [];
    }
  };
  const closeList = () => { list = null; };
  for (let at = 0; at < lines.length; at += 1) {
    const raw = lines[at];
    const line = raw.replace(/\s+$/u, "");
    const bullet = line.match(/^\s{0,3}[-*•]\s+(.*)$/u);
    const numbered = line.match(/^\s{0,3}(\d{1,3})[.)]\s+(.*)$/u);
    const heading = line.match(/^\s{0,3}#{1,4}\s+(.*)$/u);
    const quoted = line.match(/^\s{0,3}>\s?(.*)$/u);
    if (!line.trim()) { flush(); closeList(); continue; }
    const headers = tableCells(line);
    const delimiters = tableCells(lines[at + 1] ?? "");
    if (!quoted && !heading && !bullet && !numbered && headers?.length &&
        delimiters?.length === headers.length && delimiters.every((cell) => /^:?-+:?$/u.test(cell))) {
      flush(); closeList();
      const wrapper = document.createElement("div");
      wrapper.className = "markdown-table";
      const table = document.createElement("table");
      const head = document.createElement("thead");
      const body = document.createElement("tbody");
      const row = (cells, section, tag) => {
        const tr = document.createElement("tr");
        headers.forEach((_, column) => {
          const cell = document.createElement(tag);
          if (tag === "th") cell.scope = "col";
          const delimiter = delimiters[column];
          cell.style.textAlign = delimiter.endsWith(":") ? (delimiter.startsWith(":") ? "center" : "right") : "left";
          inline(cells[column] ?? "", cell);
          tr.append(cell);
        });
        section.append(tr);
      };
      row(headers, head, "th");
      at += 1;
      while (at + 1 < lines.length) {
        const next = lines[at + 1];
        if (/^\s{0,3}(?:>|#{1,4}\s|[-*•]\s|\d{1,3}[.)]\s)/u.test(next)) break;
        const cells = tableCells(next);
        if (!cells?.length) break;
        row(cells, body, "td");
        at += 1;
      }
      table.append(head, body);
      wrapper.append(table);
      fragment.append(wrapper);
    } else if (quoted) {
      if (paragraph.length) flush();
      closeList();
      quote.push(quoted[1]);
    } else if (heading) {
      flush(); closeList();
      const h = document.createElement("h3");
      inline(heading[1], h);
      fragment.append(h);
    } else if (bullet || numbered) {
      flush();
      const kind = bullet ? "UL" : "OL";
      if (!list || list.tagName !== kind) {
        list = document.createElement(kind.toLowerCase());
        if (numbered && Number(numbered[1]) !== 1) list.start = Number(numbered[1]);
        fragment.append(list);
      }
      const item = document.createElement("li");
      inline(bullet ? bullet[1] : numbered[2], item);
      list.append(item);
    } else if (list && /^\s{2,}\S/u.test(raw)) {
      // An indented line continues the list item above it.
      list.lastElementChild.append(" ");
      inline(line.trim(), list.lastElementChild);
    } else {
      closeList();
      if (quote.length) flush();
      paragraph.push(line);
    }
  }
  flush();
  return fragment;
}
