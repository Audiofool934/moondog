// Node features the room imports but the browser frames never need.
export function unavailable(name) {
  return () => { throw new Error(`${name} is not available in a browser.`); };
}
