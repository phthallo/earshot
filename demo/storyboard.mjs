// The shot list. Times are seconds; every shot is a hard cut. Captions hold for
// the shot and fade in over 0.3 s. Numbers come from the running bridge at
// build time (see data()).

export const APP = process.env.APP_URL || 'http://localhost:5173';
export const BRIDGE = process.env.BRIDGE_URL || 'http://localhost:8080';
export const FPS = 30;
export const W = 1920;
export const H = 1080;

// Clips are recorded from the live app by record.mjs; cards are rendered by
// render-cards.mjs. `src` names the file under demo/out.
export const shots = [
  { id: 'open', src: 'clips/orbit.mp4', seconds: 7, caption: 'Cal Hacks 13.0, Palace of Fine Arts. Tonight, live.' },
  { id: 'title', src: 'cards/title.png', seconds: 4 },
  { id: 'plan', src: 'clips/plan-zoom.mp4', seconds: 8, caption: 'Every dot is a phone within earshot of a $5 node.' },
  { id: 'zone', src: 'clips/zone-card.mp4', seconds: 7, caption: 'Counts against capacity, refreshed every two seconds.' },
  { id: 'device', src: 'clips/device.mp4', seconds: 9, caption: 'Tap a dot: which nodes hear it, and how long it has stayed.' },
  { id: 'xray', src: 'clips/xray.mp4', seconds: 7, caption: 'Registered people show by name. Everyone else stays a dot.' },
  { id: 'arch', src: 'cards/arch.mp4', seconds: 18 },
  { id: 'n1', src: 'cards/num-phones.png', seconds: 3 },
  { id: 'n2', src: 'cards/num-stay.png', seconds: 3 },
  { id: 'n3', src: 'cards/num-cost.png', seconds: 3 },
  { id: 'end', src: 'cards/end.png', seconds: 5 },
];

// Architecture card steps, revealed one at a time; the packet dot walks the path.
export const arch = [
  { k: 'phone', title: 'A phone', line: 'sends wifi probe frames on its own, no app installed.' },
  { k: 'node', title: 'ESP32 node', line: 'hears them within about 30 m, keeps the MAC and signal strength.' },
  { k: 'espnow', title: 'ESP-NOW', line: 'battery nodes broadcast their lines to the node on USB. No access point needed.' },
  { k: 'bridge', title: 'Go bridge', line: 'salts and hashes each address. The raw MAC stays in memory for 10 seconds.' },
  { k: 'db', title: 'SpacetimeDB', line: 'holds hashes, zone counts and grid cells. Browsers subscribe to the tables.' },
  { k: 'map', title: 'The map', line: 'redraws every two seconds, in 3D or as a plan.' },
];

// Live numbers for the number cards. Falls back to the figures from the night
// of 24 Oct when the bridge is not running.
export async function data() {
  const fallback = { phones: 404, zone: 'Mezzanine Hacking', stayMin: 8, inRange: 73 };
  try {
    const d = await (await fetch(`${BRIDGE}/api/dwell`)).json();
    const top = [...(d.zones ?? [])].sort((a, b) => b.unique - a.unique)[0];
    if (!top) return fallback;
    const names = { mezz_hack: 'Mezzanine Hacking', hardware: 'Hardware Desk', mezz_relax: 'Relaxation Space' };
    return { phones: top.unique, zone: names[top.zoneId] ?? top.zoneId, stayMin: Math.round(top.medianStayMin), inRange: d.now };
  } catch {
    return fallback;
  }
}
