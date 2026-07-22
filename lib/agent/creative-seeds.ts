/**
 * Art-direction seeds for creative mode (a genuinely new project with no
 * design system).
 *
 * Models given "full creative freedom" reliably converge on the same safe,
 * samey design — light background, one blue accent, centered containers.
 * Injecting a few RANDOMLY chosen concrete directions per run breaks that
 * determinism cheaply: the model can adopt one, adapt it, or reject them all,
 * but it can no longer fall into its default groove unprompted, and two users
 * building the same brief get visibly different sites.
 *
 * Keep each seed to one dense line — the picked seeds ride along with the
 * user's message on every blank-new-project turn, so brevity is a direct
 * per-request token cost. Seeds name real fonts (verified Google Fonts) so
 * the agent can install them directly.
 */

interface CreativeSeed {
  /** One-line direction: personality, palette, type pairing, signature move. */
  direction: string;
}

const CREATIVE_SEEDS: CreativeSeed[] = [
  { direction: 'Warm editorial — cream #faf6ef ground, ink #1c1917 text, burnt-orange #c2410c accent; "Fraunces" display / "Inter" body; oversized serif numerals overlapping section edges' },
  { direction: 'Brutalist grid — white ground, #111 text, signal-red #dc2626 accent; "Space Grotesk" display / "IBM Plex Mono" details; 2px borders on everything, zero radius, visible column rules' },
  { direction: 'Quiet luxury — deep green #1a2e22 ground, bone #ece8df text, brass #b08d57 accent; "Cormorant Garamond" display / "Jost" body; thin hairline dividers and huge whitespace' },
  { direction: 'Neon dark — near-black #0a0a0f ground, #f4f4f5 text, electric lime #a3e635 accent; "Sora" display / "Inter" body; glowing accent borders and one full-bleed gradient band' },
  { direction: 'Soft pastel tech — lavender-tinted #f6f4fb ground, #2e2a3a text, violet #7c3aed accent; "Plus Jakarta Sans" throughout with 800-weight heroes; pill-shaped everything, cards floating over a tinted band' },
  { direction: 'Swiss poster — off-white #f5f5f4 ground, #171717 text, cobalt #1d4ed8 accent; "Archivo" black-weight display / "Archivo" body; massive left-aligned type, asymmetric 70/30 splits, no centered sections' },
  { direction: 'Retro print — paper #f7f1e3 ground, #292524 text, teal #0f766e + mustard #d97706 duotone; "DM Serif Display" / "DM Sans"; thick offset card shadows like misregistered ink' },
  { direction: 'Monochrome bold — pure white ground, pure black text, NO accent color; "Anton" display / "Inter" body; type as the only decoration, 120px+ heroes, sections separated by 4px rules' },
  { direction: 'Dusk gradient — indigo-to-plum gradient ground (#312e81 → #701a75), #fafafa text, peach #fdba74 accent; "Outfit" display / "Inter" body; glassy backdrop-blur cards' },
  { direction: 'Organic warm — terracotta #9a3412 ground with sand #fef3c7 panels, espresso text; "Lora" display / "Karla" body; fully-rounded 24px cards and arch-shaped image masks (border-radius 50% top)' },
  { direction: 'Industrial mono — concrete #d6d3d1 ground, #1c1917 text, safety-yellow #facc15 accent; "Oswald" condensed display / "IBM Plex Sans" body; caution-stripe dividers, hard shadows, uppercase labels' },
  { direction: 'Deep ocean — navy #0c1b33 ground, #e2e8f0 text, aqua #22d3ee accent; "Manrope" display at 800 / "Manrope" body; oversized outlined type behind content layers' },
  { direction: 'Editorial noir — black #0a0a0a ground, warm-white #fafaf5 text, crimson #be123c accent; "Playfair Display" italic heroes / "Source Sans 3" body; magazine-style asymmetric two-column sections with drop caps' },
  { direction: 'Candy pop — blush #fdf2f8 ground, #500724 text, hot-pink #db2777 + sky #0ea5e9 accents; "Bricolage Grotesque" display / "Nunito Sans" body; sticker-style cards with 3px borders and rotated badges' },
  { direction: 'Terminal green — #0c0c0c ground, #e5e5e5 text, phosphor #4ade80 accent; "JetBrains Mono" display AND body; ASCII-style borders, blinking-cursor motifs, tabular layouts' },
  { direction: 'Alpine clean — ice-white #f8fafc ground, slate #0f172a text, glacier #0284c7 accent; "Albert Sans" display / "Inter" body; full-bleed photography bands alternating with narrow 720px text columns' },
  { direction: 'Art-deco luxe — charcoal #1c1a17 ground, champagne #f3e5c3 text and accent; "Marcellus" display / "Figtree" body; symmetric geometric borders, gold hairlines, centered but ornamental' },
  { direction: 'Sunset bold — gradient #f97316 → #db2777 hero ground over warm-white page, #1c1917 text; "Clash-style heavy sans: Archivo Black" display / "Rubik" body; diagonal section cuts via skewed dividers' },
];

/**
 * Pick `count` distinct seeds at random. Randomness is the point — it widens
 * run-to-run variety, which cached/deterministic prompting otherwise kills.
 */
export function pickCreativeSeeds(count: number): string[] {
  const pool = [...CREATIVE_SEEDS];
  const picked: string[] = [];
  while (picked.length < count && pool.length > 0) {
    const index = Math.floor(Math.random() * pool.length);
    picked.push(pool[index].direction);
    pool.splice(index, 1);
  }
  return picked;
}
