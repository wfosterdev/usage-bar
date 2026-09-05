/**
 * Colour schemes, defined once and consumed by both surfaces: the web UI sets
 * them as CSS custom properties, and the macOS app reads the resolved menu bar
 * colours out of /api/menubar. Adding a theme here is enough — the Swift app
 * never needs recompiling for a new palette.
 *
 * Severity colours (ok / warn / crit) stay recognisably green / amber / red in
 * every theme, including Mono. They are not decoration: they are the only thing
 * distinguishing "fine" from "about to be rate limited" at a glance, so themes
 * restyle the chrome and the accent, never the meaning.
 */

/** Keys every palette must define, in both modes. */
export const PALETTE_KEYS = ['bg', 'panel', 'panel2', 'ink', 'inkDim', 'line', 'accent', 'ok', 'warn', 'crit'];

export const THEMES = [
  {
    id: 'ember',
    name: 'Ember',
    description: 'Warm terracotta on charcoal',
    light: { bg: '#f7f7f5', panel: '#ffffff', panel2: '#f0efec', ink: '#1c1b19', inkDim: '#6b6862', line: '#e0ded8', accent: '#c96442', ok: '#3f7d58', warn: '#a97a09', crit: '#b4413c' },
    dark:  { bg: '#14130f', panel: '#1e1c18', panel2: '#272420', ink: '#f2efe8', inkDim: '#9a958a', line: '#322e28', accent: '#e08160', ok: '#6cbf8a', warn: '#d9a441', crit: '#e0645c' },
  },
  {
    id: 'slate',
    name: 'Slate',
    description: 'Cool blue-grey, low glare',
    light: { bg: '#f5f7fa', panel: '#ffffff', panel2: '#eceff4', ink: '#16202b', inkDim: '#5d6b7a', line: '#dae0e8', accent: '#3b7ea1', ok: '#2f7d5d', warn: '#a2740f', crit: '#b03f45' },
    dark:  { bg: '#0f141a', panel: '#171e26', panel2: '#1f2831', ink: '#e8eef5', inkDim: '#8b9aa9', line: '#2a3541', accent: '#5aa9d0', ok: '#5fc294', warn: '#d9a441', crit: '#e2666c' },
  },
  {
    id: 'forest',
    name: 'Forest',
    description: 'Muted greens',
    light: { bg: '#f5f8f4', panel: '#ffffff', panel2: '#eaf0e8', ink: '#1a231a', inkDim: '#5c6a5c', line: '#d8e2d6', accent: '#3f7d4f', ok: '#2f7d5d', warn: '#a2740f', crit: '#b0453f' },
    dark:  { bg: '#0f140f', panel: '#171e17', panel2: '#1f281f', ink: '#e9f0e8', inkDim: '#8b9a8b', line: '#2a352a', accent: '#6bbd7c', ok: '#6cbf8a', warn: '#d9a441', crit: '#e06a62' },
  },
  {
    id: 'teal',
    name: 'Teal',
    description: 'Cyan-leaning, high clarity',
    light: { bg: '#f4f9f9', panel: '#ffffff', panel2: '#e8f2f2', ink: '#14211f', inkDim: '#566a68', line: '#d5e4e3', accent: '#227e7e', ok: '#2f7d5d', warn: '#a2740f', crit: '#b0453f' },
    dark:  { bg: '#0e1413', panel: '#161e1d', panel2: '#1e2827', ink: '#e6f1f0', inkDim: '#85999a', line: '#283534', accent: '#4fb3b3', ok: '#5fc294', warn: '#d9a441', crit: '#e2666c' },
  },
  {
    id: 'violet',
    name: 'Violet',
    description: 'Deep purple accent',
    light: { bg: '#f8f6fb', panel: '#ffffff', panel2: '#f0ecf6', ink: '#1e1a26', inkDim: '#665d78', line: '#e2dcec', accent: '#6f4fb5', ok: '#2f7d5d', warn: '#a2740f', crit: '#b4413c' },
    dark:  { bg: '#131019', panel: '#1c1824', panel2: '#25202e', ink: '#efeaf7', inkDim: '#978db0', line: '#322b3d', accent: '#a98ae0', ok: '#6cbf8a', warn: '#d9a441', crit: '#e0645c' },
  },
  {
    id: 'mono',
    name: 'Mono',
    description: 'Greyscale chrome; severity stays coloured',
    light: { bg: '#f6f6f6', panel: '#ffffff', panel2: '#ededed', ink: '#171717', inkDim: '#6a6a6a', line: '#dcdcdc', accent: '#3f3f3f', ok: '#3f7d58', warn: '#a97a09', crit: '#b4413c' },
    dark:  { bg: '#121212', panel: '#1b1b1b', panel2: '#242424', ink: '#f0f0f0', inkDim: '#9a9a9a', line: '#303030', accent: '#c4c4c4', ok: '#6cbf8a', warn: '#d9a441', crit: '#e0645c' },
  },
];

export const THEME_IDS = THEMES.map((t) => t.id);
export const DEFAULT_THEME = 'ember';
export const APPEARANCES = ['system', 'light', 'dark'];
/** Show how much is left, or how much is spent. */
export const METRICS = ['remaining', 'used'];
/** Track just the 5h session, or whichever limit is closest to biting. */
export const SCOPES = ['session', 'worst'];

export function getTheme(id) {
  return THEMES.find((t) => t.id === id) || THEMES.find((t) => t.id === DEFAULT_THEME);
}

/** The palette for one theme in one mode. `mode` is 'light' or 'dark'. */
export function palette(id, mode = 'dark') {
  const theme = getTheme(id);
  return theme[mode === 'light' ? 'light' : 'dark'];
}

/**
 * Menu bar chip backgrounds.
 *
 * The readability problem the menu bar has is that its background is the
 * wallpaper: translucent, arbitrary, and repainted by macOS whenever the
 * desktop changes. No fixed text colour survives that. The fix is to stop
 * fighting it and paint our own opaque plate behind the text, so the only
 * contrast that matters is one we control and can measure.
 *
 * Two fills, and they mean different things:
 *   soft  — a plate that matches the system surface. Quiet; reads as chrome.
 *   solid — a saturated badge in the family colour. Loud; reads as a control.
 * Both are defined per system mode, so the chip tracks the laptop's appearance
 * rather than the dashboard's theme setting.
 *
 * Text is never configured. It is DERIVED from the chip via `readableInk`,
 * which is what makes "always readable" a guarantee rather than an intention.
 */
export const MENUBAR_SCHEMES = [
  {
    id: 'system',
    name: 'System',
    description: 'No plate — follows the menu bar, like every other icon',
    light: null,
    dark: null,
  },
  {
    id: 'neutral',
    name: 'Neutral',
    description: 'Grey plate, no hue',
    light: { soft: '#e6e6e8', solid: '#2f2f31' },
    dark: { soft: '#2f2f31', solid: '#e6e6e8' },
  },
  {
    id: 'ember',
    name: 'Ember',
    description: 'Warm terracotta',
    light: { soft: '#f6e2da', solid: '#9c452a' },
    dark: { soft: '#3a2620', solid: '#c96442' },
  },
  {
    id: 'slate',
    name: 'Slate',
    description: 'Cool blue-grey',
    light: { soft: '#dde8ef', solid: '#2b5f7a' },
    dark: { soft: '#1f313c', solid: '#38768f' },
  },
  {
    id: 'forest',
    name: 'Forest',
    description: 'Muted green',
    light: { soft: '#dde9dd', solid: '#2e6039' },
    dark: { soft: '#1f2f22', solid: '#3f7d4f' },
  },
  {
    id: 'teal',
    name: 'Teal',
    description: 'Cyan-leaning',
    light: { soft: '#d8ebeb', solid: '#1d6666' },
    dark: { soft: '#1b3130', solid: '#227e7e' },
  },
  {
    id: 'violet',
    name: 'Violet',
    description: 'Deep purple',
    light: { soft: '#e6dff5', solid: '#553c8c' },
    dark: { soft: '#2a2340', solid: '#6f4fb5' },
  },
];

export const MENUBAR_SCHEME_IDS = MENUBAR_SCHEMES.map((s) => s.id);
/** How strongly the chip is painted. 'none' means no chip at all. */
export const MENUBAR_FILLS = ['none', 'soft', 'solid'];

/** How a usage bar is drawn. Affects both the dropdown and the dashboard. */
export const GAUGE_STYLES = ['blocks', 'segments', 'dots', 'line'];
/** How a usage bar is coloured. */
export const GAUGE_PALETTES = ['severity', 'accent', 'gradient', 'mono'];

/** Glyph pairs the macOS dropdown draws its bars from, one per gauge style. */
export const GAUGE_GLYPHS = {
  blocks: { filled: '█', empty: '░' },
  segments: { filled: '▰', empty: '▱' },
  dots: { filled: '●', empty: '○' },
  line: { filled: '━', empty: '─' },
};

/* ---------- contrast ----------
   The whole point of the menu bar chip is that its readability is provable,
   so the maths lives here rather than being eyeballed per palette. */

function toRgb(hex) {
  const h = String(hex || '').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) || 0);
}

/** WCAG relative luminance. */
export function luminance(hex) {
  const [r, g, b] = toRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colours, 1:1 to 21:1. */
export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The most readable ink for a given background.
 *
 * Tries near-black and near-white — softened slightly off pure values, which
 * looks less harsh at menu bar sizes without meaningfully costing contrast —
 * and returns whichever wins. Because it picks by measurement, adding a chip
 * colour can never produce unreadable text.
 */
export function readableInk(background) {
  if (!background) return null;
  const candidates = ['#12120f', '#ffffff'];
  return candidates
    .map((ink) => ({ ink, ratio: contrastRatio(ink, background) }))
    .sort((a, b) => b.ratio - a.ratio)[0].ink;
}

export function getMenubarScheme(id) {
  return MENUBAR_SCHEMES.find((s) => s.id === id) || MENUBAR_SCHEMES[0];
}

/**
 * Resolves the menu bar chip for one system mode.
 *
 * Returns `background: null` when there is no chip, which tells the Swift side
 * to fall back to NSColor.labelColor — still the only correct answer when we
 * are painting straight onto the wallpaper.
 */
export function menubarColors(themeId, mode, appearance = {}) {
  const p = palette(themeId, mode);
  const fill = MENUBAR_FILLS.includes(appearance.fill) ? appearance.fill : 'none';
  const scheme = getMenubarScheme(appearance.scheme);
  const severity = appearance.severity !== false;
  const swatch = scheme[mode === 'light' ? 'light' : 'dark'];

  // A chip is a background plus the ink that measurably reads on it. Deriving
  // the ink rather than configuring it is what makes readability a guarantee.
  const chip = (background) => ({ background: background || null, text: readableInk(background) });

  if (fill === 'none' || !swatch) {
    // No plate: we are painting onto the wallpaper, so normal text must defer
    // to NSColor.labelColor (null) and only severity may assert a colour.
    return {
      scheme: scheme.id,
      fill: 'none',
      severity,
      normal: { background: null, text: null },
      warning: { background: null, text: severity ? p.warn : null },
      critical: { background: null, text: severity ? p.crit : null },
      accent: p.accent,
    };
  }

  const base = swatch[fill];
  return {
    scheme: scheme.id,
    fill,
    severity,
    normal: chip(base),
    // With a plate, severity is far louder as a change of background than as a
    // change of text colour — and the derived ink keeps it readable either way.
    warning: severity ? chip(p.warn) : chip(base),
    critical: severity ? chip(p.crit) : chip(base),
    accent: p.accent,
  };
}

/**
 * Approximate material macOS draws behind an open menu, per appearance.
 *
 * Unlike the menu bar — whose background is the wallpaper and therefore
 * unknowable — a menu has a predictable, near-opaque backing that follows the
 * system appearance. That is what makes it safe to theme the dropdown at all,
 * and it is why these two surfaces get different treatment.
 */
export const MENU_MATERIAL = { light: '#f0f0f0', dark: '#2b2b2b' };

/**
 * Colours for the menu bar's dropdown.
 *
 * The header keeps the chosen scheme even when the menu bar itself is unplated:
 * "no plate" exists because the wallpaper is unpredictable, and that reason
 * does not apply here. So the dropdown always shows the colour you picked.
 */
export function menuColors(themeId, mode, appearance = {}) {
  const p = palette(themeId, mode);
  const scheme = getMenubarScheme(appearance.scheme);
  const swatch = scheme[mode === 'light' ? 'light' : 'dark'];
  const header = swatch ? swatch.solid : null;

  return {
    material: MENU_MATERIAL[mode === 'light' ? 'light' : 'dark'],
    ink: p.ink,
    inkDim: p.inkDim,
    accent: p.accent,
    line: p.line,
    headerBackground: header,
    headerText: readableInk(header),
  };
}

/**
 * Colour for a usage bar at `percent`.
 *
 * 'severity' is the default because the bar's job is to say whether you are
 * fine; the others exist because some people want a calmer dashboard and are
 * willing to read the number instead.
 */
export function gaugeColor(themeId, mode, gaugePalette, percent) {
  const p = palette(themeId, mode);
  const pct = Math.min(100, Math.max(0, Number(percent) || 0));
  switch (gaugePalette) {
    case 'accent':
      return p.accent;
    case 'mono':
      return pct >= 90 ? p.ink : p.inkDim;
    case 'gradient': {
      // ok -> warn across the first 75%, warn -> crit across the rest, so the
      // ramp lines up with the thresholds the severity palette uses.
      const [from, to, t] = pct <= 75
        ? [p.ok, p.warn, pct / 75]
        : [p.warn, p.crit, (pct - 75) / 25];
      return mixHex(from, to, t);
    }
    case 'severity':
    default:
      return pct >= 90 ? p.crit : pct >= 75 ? p.warn : p.ok;
  }
}

/** Linear blend in sRGB. Good enough for a progress bar ramp. */
export function mixHex(a, b, t) {
  const clamp = Math.min(1, Math.max(0, t));
  const [ra, ga, ba] = toRgb(a);
  const [rb, gb, bb] = toRgb(b);
  const to2 = (n) => Math.round(n).toString(16).padStart(2, '0');
  return `#${to2(ra + (rb - ra) * clamp)}${to2(ga + (gb - ga) * clamp)}${to2(ba + (bb - ba) * clamp)}`;
}

/** Everything the settings page needs to draw the menu bar chip previews. */
export function menubarCatalog() {
  return MENUBAR_SCHEMES.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    fills: MENUBAR_FILLS.filter((f) => f !== 'none').map((fill) => ({
      fill,
      light: s.light ? { background: s.light[fill], text: readableInk(s.light[fill]) } : null,
      dark: s.dark ? { background: s.dark[fill], text: readableInk(s.dark[fill]) } : null,
    })),
  }));
}

/** Sample bars for each style, so the settings page can show what it means. */
export function gaugeCatalog() {
  return {
    styles: GAUGE_STYLES.map((id) => ({ id, sample: renderTextBar(62, id, 10) })),
    palettes: GAUGE_PALETTES.map((id) => ({
      id,
      stops: [20, 60, 80, 95].map((pct) => gaugeColor(DEFAULT_THEME, 'dark', id, pct)),
    })),
  };
}

/** The dropdown's text bar. Shared so the sample and the real thing agree. */
export function renderTextBar(percent, style = 'blocks', width = 14) {
  const g = GAUGE_GLYPHS[style] || GAUGE_GLYPHS.blocks;
  const pct = Math.min(100, Math.max(0, Number(percent) || 0));
  const filled = Math.round((pct / 100) * width);
  return g.filled.repeat(filled) + g.empty.repeat(Math.max(0, width - filled));
}

/** Everything the settings page needs to draw swatches. */
export function themeCatalog() {
  return THEMES.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    light: t.light,
    dark: t.dark,
  }));
}
