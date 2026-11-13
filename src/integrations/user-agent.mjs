import { readFileSync } from "node:fs";

// The identity Moondog gives public music-data services: its name, version and project page.
const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

export const MOONDOG_USER_AGENT = `Moondog/${version} (https://github.com/Audiofool934/moondog)`;
