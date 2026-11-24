// The bridge binds to a single Tailscale IPv4 address. Loopback is for Simulator.
export function privateHost(value) {
  if (value === '127.0.0.1') return true;
  const octets = String(value).split('.');
  return (
    octets.length === 4 &&
    octets.every((n) => /^(0|[1-9]\d{0,2})$/.test(n) && Number(n) <= 255) &&
    octets[0] === '100' &&
    Number(octets[1]) >= 64 &&
    Number(octets[1]) < 128
  );
}
