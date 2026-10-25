# Style guide

The look comes from the landing page hero: a fluid gradient in deep navy and sky blue, a serif italic headline, and a grotesk for everything else. Every other surface uses the same tokens. They are declared in `client/src/styles.css`; the landing page's own additions live in `client/src/landing.css`, scoped under `.landing`.

## Colour

Two blues carry the page. One warm and one cool accent mark state, and they are used sparingly.

| Token | Hex | Use |
|---|---|---|
| `--night` | `#11153d` | Page background, text on light pills |
| `--navy-2` | `#0f1d5b` | Deep end of the hero gradient, ink on white cards |
| `--surface` | `#121847` | Top of a dark card gradient |
| `--surface-2` | `#0e1239` | Bottom of a dark card gradient |
| `--sky` | `#75bcff` | Links, outlined pills, the bright end of the hero |
| `--sky-2` | `#b6d3ff` | Filled pills, nav links, selected tab |
| `--sky-3` | `#dfeeff` | Pill hover |
| `--ink` | `#f5f4f4` | Headlines and body on dark |
| `--ink-2` | `#c5d3f3` | Secondary text on dark |
| `--ink-3` | `#98acd9` | Labels, diagram strokes, footer text |
| `--coral` | `#ff9d8a` | Attention on dark: a stage where data stops, a warning, a live marker |
| `--coral-ink` | `#b84a39` | The same role on white |
| `--mint` | `#8fe3c9` | Kept or OK state on dark |
| `--mint-ink` | `#0e6b57` | The same role on white |
| `--amber` | `#e7ac66` | A node on the map, and the warm hint in the hero shader. Nothing else |
| `--paper` | `#fbfbfe` | White cards |
| `--edge` | `rgba(117,188,255,.22)` | The 1px gap colour between tiles |
| `--hairline` | `rgba(157,182,229,.25)` | Section rules |

Coral is the complement of the sky blue. Mint sits opposite the warm end of the shader. Both pass 7:1 on `--night` for text, and their ink variants pass 4.5:1 on `--paper`.

Do not use the lime green (`#b9df74`) or rust (`#b85c3a`) from the old theme. Pure white (`#fff`) only appears inside SVG labels.

## Type

| Role | Face | Size | Notes |
|---|---|---|---|
| Hero headline | Arapey italic 400 | `clamp(3rem, 7.5vw, 6.2rem)` | line-height 0.95, letter-spacing -0.04em |
| Section heading (h2) | Arapey italic 400 | `clamp(2rem, 4.2vw, 3.2rem)` | line-height 1, letter-spacing -0.03em |
| Big figure | Arapey italic 400 | `clamp(1.9rem, 3.4vw, 2.8rem)` | stats strip, price output |
| Card heading (h3) | Alte Haas Grotesk 700 | 1.1 to 1.2rem | letter-spacing -0.03em |
| Body | Alte Haas Grotesk 400 | 17px, 1.4 line-height | letter-spacing -0.02em, measure 62ch |
| Label | Alte Haas Grotesk 700 | 0.85 to 0.9rem | `--ink-3` |
| Nav | Alte Haas Grotesk 700 | 13px uppercase | letter-spacing -0.04em |

Letter-spacing is always zero or negative. Arapey is only ever italic.

## Shape and spacing

- Pills and bars: `border-radius: 999px`.
- Cards and tile groups: `--radius` (0.8rem).
- Tile groups are a grid with a 1px `--edge` gap and 1px padding, so the edge colour draws the lines.
- Section padding: `clamp(3.5rem, 8vw, 7rem)`. Sections are separated by a `--hairline` rule.
- Side gutter: `clamp(16px, 4vw, 48px)`. Content width 1180px.
- Space inside cards: 1.25rem to 2rem.

## Buttons

- Primary pill: `--sky-2` fill, `--night` text.
- Secondary pill: 2px `--sky` border, `--sky` text, transparent fill.
- Hover: both become `--sky-3` fill and lift 2px.
- Minimum height 44px. Focus ring is 2px `--sky` with 3px offset.
- A tab in the data path uses the same pill; a warning tab swaps sky for coral.

## Cards

The section layout borrows from blueprint.zip: each section is one rounded container with a 1px edge, split into flat cells by 1px lines. Nothing floats, nothing glows, and the cells share one fill.

- Dark cell: flat `--surface`, no border of its own, inside a `--edge` grid (1px gap, 1px padding, `--radius` corners).
- White card: `--paper` background, `--navy-2` ink, `color-scheme: light`, soft shadow `0 .35rem .8rem rgba(0,0,0,.25)`. Used for facts and the price slider.
- Glyph tiles are the one exception: a gradient from `--navy-2` to a brighter blue behind a single drawing. The amber tile is the only warm one and it holds a node drawing.
- Lists of use cases are rows in the same container, one cell per row, not three cards side by side.

## Hero

- The backdrop is a WebGL fluid gradient. Colours in the shader are `--night`, `--navy-2`, `--sky`, `--sky-2` and a 22% mix of `--amber`.
- Text on the hero gets a soft dark shadow so the headline stays readable over the bright patch.
- Below the hero the page is plain `--night`. No stars, no planet.

## Do

- One accent per meaning: coral for stop or warn, mint for kept or OK, amber for a node.
- Keep copy white or `--ink-2` on dark, `--navy-2` on white.
- Use the stats strip pattern (figure above, label below) for any row of numbers.

## Don't

- No positive letter-spacing.
- No gradient text, no glow shadows.
- No new colours. If a state has no token, it uses `--ink-3`.
- No coral or mint fills larger than a bar or a badge.
