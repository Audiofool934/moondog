// These parsers read only the actual listener message. Metadata and model tool
// arguments never create a contextual selection or an additional write grant.
const digits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function number(value) {
  if (/^\d+$/u.test(value)) return Number(value);
  if (/^[一二两三四五六七八九]?十[一二三四五六七八九]?$/u.test(value)) {
    const [tens, ones] = value.split("十");
    return (digits[tens] ?? 1) * 10 + (digits[ones] ?? 0);
  }
  return digits[value] ?? null;
}

export function playbackFollowupIntent(text) {
  if (typeof text !== "string" || text.length > 500) return null;
  const value = text.normalize("NFKC").trim().replace(/[.!。！]+$/u, "");
  const ordinal = value.match(/^(?:(?:play|choose|number)\s*|(?:播放|选|来|第)\s*)?(\d{1,2}|[一二三四五六七八九十])(?:\s*(?:个|首|号|那个|这个|版本))?$/iu);
  if (ordinal) return { kind: "ordinal", ordinal: number(ordinal[1]) };
  if (/^(?:please\s+)?(?:retry|try (?:it )?again|play (?:it )?again|重试|再试(?:一次|一下)?|再来一次)$/iu.test(value)) return { kind: "retry" };
  if (/^(?:(?:please|can you|could you|would you)\s+)?(?:play|put)\s+(?:it|that|this|the (?:same |selected )?(?:song|track|version))\s+(?:on|through|using)\s+\S/iu.test(value) ||
      /^(?:请|可以|能不能|能否)?(?:在|用).{1,128}(?:播放|放)(?:它|这首|那首|同一首|刚才那首)|^(?:请)?(?:把|将)(?:它|这首|那首|同一首|刚才那首).{0,12}(?:放到|换到|转到|在).{1,128}(?:播放|上放|上播)/u.test(value)) return { kind: "retarget" };
  if (/^(?:换(?:一|另一个|个)|换一个(?:版本)?|另一个版本|换个版本|再换一版)(?:[，,。\s].*|不好听|这(?:个)?版本不好听)?$/u.test(value) ||
      /^(?:try|play|choose|pick|put on) (?:a |an )?(?:different|another) (?:one|version|mix)(?:[,.!\s].*)?$/iu.test(value)) return { kind: "alternative" };
  return null;
}

const englishCounts = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000, million: 1000000 };
const englishCountWords = Object.keys(englishCounts).join("|");
const englishCountPattern = `(?:${englishCountWords})(?:(?:[ -]+)(?:and +)?(?:${englishCountWords}))*`;
const leadingEnglishCount = new RegExp(`^${englishCountPattern}\\b`, "iu");
const mediaCounts = new RegExp(`(?<![\\p{L}\\p{N}])(?:[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)|${englishCountPattern})(?![\\p{L}\\p{N}])`, "giu");

function queueCount(command) {
  const value = command.replace(/^(?:(?:only|just|exactly|another|an additional|a further|the next)\s+)+/iu, "").trim();
  if (/^(?:no|none|nothing)\b/iu.test(value)) return 0;
  // Chinese quantities may follow 找/推荐/刚才的 inside the accepted command.
  const chinese = [...value.matchAll(/([零〇一二两三四五六七八九十百千万亿]+|[+-]?\d+(?:\.\d+)?)\s*首/gu)];
  if (chinese.length > 1) return 0;
  if (chinese.length === 1) return /^[+-]?\d/u.test(chinese[0][1]) ? Number(chinese[0][1]) : number(chinese[0][1]) ?? 0;
  const tokens = [...value.matchAll(mediaCounts)];
  if (tokens.some(match => /^\s*(?:[-/]|\b(?:and|or|to|through|point)\b)/iu.test(value.slice(match.index + match[0].length)))) return 0;
  const media = tokens.filter(match => /^\s+(?:(?!\bby\b)[^\s,;]+\s+){0,8}(?:songs?|tracks?)\b/iu.test(value.slice(match.index + match[0].length)));
  if (media.length > 1) return 0;
  const numeric = value.match(/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?![\p{L}\p{N}])/u);
  const english = value.match(leadingEnglishCount);
  const count = numeric ?? english ?? media[0];
  if (!count) return /^(?:a|an)\s+(?:song|track)\b/iu.test(value) ? 1 : null;
  const tail = value.slice(count.index + count[0].length);
  // Number words in titles (Two Princes, Seven Nation Army) are not quantities.
  if (!media.length && english && tail.trim()) return null;
  if (/^[+\-.\d]/u.test(count[0])) return Number(count[0]);
  const words = count[0].toLowerCase().split(/[ -]+/u);
  if (words.length === 1) return englishCounts[words[0]];
  if (words.length === 2 && englishCounts[words[0]] >= 20 && englishCounts[words[0]] < 100 && englishCounts[words[1]] < 10) return englishCounts[words[0]] + englishCounts[words[1]];
  return 0; // Unsupported compound quantities cannot fall back to the candidate pool.
}

function queueCommand(clause, hasQueue) {
  const value = clause.trim().replace(/^(?:(?:please|can you|could you|would you|will you|i want (?:you )?to|i would like (?:you )?to)\s+)+/iu, "");
  if (/^(?:请|帮我|给我|可以|能否)*(?:问|告诉|解释|说明|介绍|看看|查看|检查|显示|列出|读取|怎么|如何|为什么)/u.test(value)) return null;
  const queue = value.match(/^queue\s+(.+)/iu);
  if (queue && !/^(?:has|have|had|is|are|was|were|will|would|can|could|should|must|may|might|does|doesn't|do|don't|did|didn't|keeps?|contains?|includes?|needs?|looks?|seems?|already|currently|status|length|size)\b/iu.test(queue[1])) return queue[1];
  const additive = value.match(/^(?:add|put|place)\s+(.+?)\s+(?:to|into|in|on)\s+(?:(?:the|my)\s+)?queue\b/iu);
  if (additive) return additive[1];
  const chineseAdditive = value.match(/^(?:(?:请|帮我|给我)\s*)?(?:加|放|排)\s*(.+?)(?:到|进)(?:我的)?队列/u);
  if (chineseAdditive) return chineseAdditive[1];
  if (hasQueue && /^(?:再来|给我|帮我|请|把|将|加入队列|加到队列|放到队列|排进队列)/u.test(value)) {
    return value.replace(/^(?:(?:再来|给我|帮我|请|把|将|加入队列|加到队列|放到队列|排进队列)\s*)+/u, "");
  }
  return null;
}

export function queueCancellationRequested(text) {
  if (typeof text !== "string") return false;
  const value = text.normalize("NFKC").replace(/[‘’]/gu, "'").trim();
  return /^(?:cancel|stop|算了|取消|不用了|别加了|不要加了)[.!。！]?$/iu.test(value) ||
    /\b(?:don't|do not|never|stop|cancel|not to)\b[^,，。;；!?！？]*\bqueue\b|(?:不要|别|取消|停止)[^，。!?！？]{0,40}(?:queue|队列)/iu.test(value);
}

function queueRefinement(value, previous) {
  if (!previous || previous.attempted || value.length > 500) return null;
  // A count or musical version choice completes a recent, unfinished listener
  // request. It never creates authority without that original queue request.
  const clauses = value.split(/[,，。;；!?！？\n]|\.(?:\s|$)/u).map(clause => clause.trim()).filter(Boolean);
  const countStart = new RegExp(`^(?:${englishCountPattern}|[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+))\\s+(?:more\\s+)?(?:songs?|tracks?)\\b`, "iu");
  const counts = clauses.filter(clause =>
    /^(?:(?:队列(?:数量|首数)?|数量|首数)\s*(?:先来|就要|来|要|改成|改为)?|先来|来|就要|改成|改为)?\s*(?:[零〇一二两三四五六七八九十百千万亿]+|[+-]?\d+(?:\.\d+)?)\s*首/u.test(clause) ||
    (countStart.test(clause) && !/\b(?:are|is|were|was|already|have|has|had)\b/iu.test(clause)))
    .map(queueCount).filter(count => count !== null);
  const choice = value.replace(/[,，.!。！?？]/gu, " ").trim();
  const versionChoice = /^(?:(?:掺|混|加|选|用|要|就|还是|只要|一点|一些|纯)\s*)*(?:翻唱|原唱|现场|录音室|女声|男声|纯音乐|老歌)(?:版本|版|气质)?(?:\s*(?:和|加|也|都|一点|一些|吧|的|翻唱|原唱|现场|录音室|女声|男声|纯音乐|老歌))*$/u.test(choice) ||
    /^(?:(?:mix in|include|add|choose|use|only|just|some|a few)\s+)*(?:covers?|originals?|original versions?|live versions?|studio versions?|instrumentals?|female vocals?|male vocals?)(?:\s+please)?$/iu.test(choice);
  if (!counts.length && !versionChoice) return null;
  const ambiguous = counts.length > 1 || /[,，;；]\s*(?:actually|instead|make that|only|改成|改为|其实)/iu.test(value);
  return { requested: ambiguous ? 0 : counts[0] ?? previous.requested,
    request: previous.request, refinement: value, queue_only: true,
    excludeKnown: previous.excludeKnown === true };
}

export function queueListeningIntent(text, previous = null) {
  if (typeof text !== "string" || text.length > 2000) return null;
  const value = text.normalize("NFKC").replace(/[‘’]/gu, "'").trim().replace(/\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/gu, count => count.replaceAll(",", ""));
  const hasQueue = /\bqueue\b|播放队列|(?:加入|加到|放到|排进|到|进)(?:我的)?队列/iu.test(value);
  if (queueCancellationRequested(value) ||
      /\b(?:explain|describe|what(?:'s| is)|why|how|whether|tell me about|can i|should i|do i|does|show|inspect|list|read|check)\b.*\bqueue\b|^(?:为什么|怎么|如何|查看|看看|显示|读取|队列里|请问|(?:帮我|给我)(?:看看|解释|说明|介绍)|(?:请|可以|能否)?(?:解释|说明|介绍))/iu.test(value)) return null;
  if (!hasQueue) return queueRefinement(value, previous);
  // A correction can reuse only the host's recent request, including its receipt.
  const correction = /^(?:i meant (?:the )?queue(?:\s*[,，]?\s*not (?:a )?playlist)?|queue\s*[,，]\s*not (?:a )?playlist|(?:我)?要的是\s*queue\s*[,，]?\s*不是歌单)[.!。！]?$/iu.test(value);
  if (correction && !previous) return null;
  const clauses = value.split(/[,，。;；!?！？]|\.(?:\s|$)/u);
  const commands = correction ? [] : clauses.map(clause => queueCommand(clause, hasQueue)).filter(command => command !== null);
  if (!correction && commands.length === 0) return queueRefinement(value, previous);
  const counts = commands.map(queueCount);
  // Multiple commands or a revised quantity need an exact request before writing.
  const ambiguous = commands.length > 1 || (counts[0] === null && clauses.some(clause => queueCommand(clause, hasQueue) === null && queueCount(clause) !== null)) || /\d,\d/u.test(value) || /[,，;；]\s*(?:actually|instead|make that|only|改成|改为|其实)/iu.test(value);
  const requested = correction ? previous.requested : ambiguous ? 0 : counts[0];
  const affirmative = value.replace(/(?:don't|don’t|do not|never)\s+[^,，.;；]+|(?:不要|别)[^，。;；]+/giu, "").replaceAll("播放队列", "队列");
  return { requested,
    request: correction ? previous.request : value,
    queue_only: correction || !/\b(?:play|resume|pause|skip|next|previous|seek|volume|shuffle|repeat|transfer|save|create|follow|unfollow)\b|播放|暂停|下一首|上一首|音量|切换设备|保存|创建|关注/iu.test(affirmative),
    ...(correction && previous.attempted ? { clarification_only: true } : {}),
    excludeKnown: /没听过|从未听|不要听过|\bunheard\b|\bnever heard\b/iu.test(value) || (correction && previous.excludeKnown === true) };
}

export function trackVersionFamily(name) {
  return String(name ?? "").normalize("NFKC").toLocaleLowerCase("en-US")
    .split(/[([（【]|\s[-—–]\s|\b(?:dj|remix|mix|version)\b/iu)[0]
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export function playbackDeviceExplicitlyRequested(text, { deviceId, deviceName, deviceRefId, ordinal } = {}) {
  if (typeof text !== "string") return false;
  // IDs are allowed only when the listener actually supplied the token. A name
  // must occur as a device target, not inside a song/artist such as Mac DeMarco.
  const negated = name => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(`(?:\\b(?:not|never|don't|do not|without|avoid)\\b|不要|别|不用|不能|禁止)[^,，。;；!?！？]{0,100}${escaped}`, "iu").test(text.normalize("NFKC").replace(/[‘’]/gu, "'"));
  };
  if (deviceId !== undefined || deviceRefId !== undefined) return !negated(deviceId ?? deviceRefId) && text.split(/\s+/u).some(token => token === (deviceId ?? deviceRefId));
  if (typeof deviceName !== "string" || !deviceName.trim()) return false;
  const value = text.normalize("NFKC").toLocaleLowerCase("en-US").trim();
  const query = deviceName.normalize("NFKC").toLocaleLowerCase("en-US").trim();
  const aliases = [["computer", "desktop", "laptop", "电脑", "计算机"], ["phone", "smartphone", "手机"], ["speaker", "音箱", "音响"]];
  const ordinalWords = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
  const chinese = Object.keys(digits).find(key => digits[key] === ordinal && key !== "两") ?? String(ordinal);
  const names = ordinal === undefined ? aliases.find(group => group.includes(query)) ?? [query] :
    [`${ordinal}${ordinal === 1 ? "st" : ordinal === 2 ? "nd" : ordinal === 3 ? "rd" : "th"} ${query}`,
      ...(ordinalWords[ordinal - 1] ? [`${ordinalWords[ordinal - 1]} ${query}`] : []),
      ...[String(ordinal), chinese].flatMap(value => [`第${value}台${query}`, `第${value}个${query}`, `第${value}台 ${query}`, `第${value}个 ${query}`])];
  if (names.some(negated)) return false;
  return names.some(name => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return value === name || new RegExp(`(?:\\b(?:on|onto|to|using|use|via|through|set)\\s+(?:(?:my|the|this)\\s+)?["“']?|(?:在|用|使用|切到|切换到|转到|通过)(?:我的|这台|这个)?\\s*)${escaped}(?:\\b|[上里播放，。]|$)`, "iu").test(value) ||
      new RegExp(`${escaped}\\s*(?:上|里)(?:播放|听|放|继续|恢复)`, "iu").test(value);
  });
}

export function playbackDeviceConstraints(text = "") {
  const value = text.normalize("NFKC").replace(/[‘’]/gu, "'");
  const noTransfer = /(?:\b(?:not|never|don't|do not|stop|avoid|without)\b[^,，。;；!?！？]{0,60}\b(?:switch|transfer|move)|(?:不要|别|不用|停止|禁止|不能)[^,，。;；!?！？]{0,30}(?:切换|切到|换到|转移|转到))/iu.test(value);
  const excludedNames = [];
  for (const match of value.matchAll(/(?:\b(?:not|never|don't|do not)\s+(?:(?:play|switch|transfer|move)\s+)?(?:on|to|using)\s+(?:(?:my|the)\s+)?)([^,.;!?\n]{1,128})/giu)) excludedNames.push(match[1].trim());
  for (const match of value.matchAll(/(?:不要|别|禁止)(?:在|用|使用|切换到|切到|转到)\s*([^，。；！？\n]{1,128}?)(?:上播放|上听|播放|上|听|$)/gu)) excludedNames.push(match[1].trim());
  return { allowTransfer: !noTransfer, excludedDeviceNames: excludedNames };
}

export function standaloneDeviceTransferRequested(text) {
  return typeof text === "string" && /\b(?:switch|transfer|move)\b|切换|切到|换到|转移|转到/iu.test(text) && playbackDeviceConstraints(text).allowTransfer;
}
