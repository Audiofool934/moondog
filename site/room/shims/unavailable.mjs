// Node features the room imports but the browser spike never needs.
export function unavailable(name) {
  return () => { throw new Error(`${name} is not available in the browser room.`); };
}
