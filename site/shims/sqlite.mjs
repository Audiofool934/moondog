// The memory store's database. The page keeps conversations in the tab instead, so it never opens one.
import { unavailable } from "./unavailable.mjs";
export const DatabaseSync = unavailable("sqlite.DatabaseSync");
export default { DatabaseSync };
