// Enough POSIX path handling for autocomplete and log paths.
export const sep = "/";
export const isAbsolute = (value) => String(value).startsWith("/");
export const join = (...parts) => normalize(parts.filter(Boolean).join("/"));
export const resolve = (...parts) => normalize(`/${parts.filter(Boolean).join("/")}`);
export const dirname = (value) => String(value).replace(/\/[^/]*\/?$/, "") || "/";
export const basename = (value, ext = "") => {
  const name = String(value).replace(/\/+$/, "").split("/").pop() ?? "";
  return ext && name.endsWith(ext) ? name.slice(0, -ext.length) : name;
};
export const extname = (value) => /\.[^./]*$/.exec(basename(value))?.[0] ?? "";
export function normalize(value) {
  const absolute = isAbsolute(value);
  const out = [];
  for (const part of String(value).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop(); else out.push(part);
  }
  return `${absolute ? "/" : ""}${out.join("/")}` || (absolute ? "/" : ".");
}
const path = { sep, isAbsolute, join, resolve, dirname, basename, extname, normalize };
path.posix = path;
export const posix = path;
export default path;
