// Node's own ANSI pattern, so the browser measures text exactly like the terminal app.
const ansi = new RegExp(
  "[\\u001B\\u009B][[\\]()#;?]*" +
  "(?:(?:(?:(?:;[-a-zA-Z\\d\\/\\#&.:=?%@~_]+)*" +
  "|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/\\#&.:=?%@~_]*)*)?" +
  "(?:\\u0007|\\u001B\\u005C|\\u009C))" +
  "|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))",
  "g",
);
export const stripVTControlCharacters = (value) => String(value).replace(ansi, "");
export const promisify = (fn) => (...args) => new Promise((resolve, reject) => fn(...args, (error, value) => error ? reject(error) : resolve(value)));
export default { stripVTControlCharacters, promisify };
