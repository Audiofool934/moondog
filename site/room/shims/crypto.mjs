import { unavailable } from "./unavailable.mjs";
export const createHash = unavailable("crypto.createHash");
export const randomUUID = () => globalThis.crypto.randomUUID();
export default { createHash, randomUUID };
