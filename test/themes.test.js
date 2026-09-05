import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  THEMES, THEME_IDS, PALETTE_KEYS, DEFAULT_THEME, APPEARANCES,
  MENUBAR_SCHEMES, MENUBAR_SCHEME_IDS, MENUBAR_FILLS, GAUGE_STYLES, GAUGE_PALETTES,
  contrastRatio, readableInk, gaugeColor, renderTextBar, menubarCatalog, gaugeCatalog,
  menuColors, MENU_MATERIAL,
  METRICS, SCOPES, getTheme, palette, menubarColors, themeCatalog,
} from '../src/core/themes.js';
import { validate, DEFAULTS } from '../src/core/config.js';

const HEX = /^#[0-9a-f]{6}$/i;

test('every theme defines every colour in both modes, as valid hex', () => {
  for (const t of THEMES) {
    for (const mode of ['light', 'dark']) {
      for (const key of PALETTE_KEYS) {
        assert.ok(t[mode][key], `${t.id}.${mode} is missing ${key}`);
        assert.match(t[mode][key], HEX, `${t.id}.${mode}.${key} is not #rrggbb`);
      }
    }
  }
});

test('theme ids are unique and every theme is named', () => {
  assert.equal(new Set(THEME_IDS).size, THEME_IDS.length);
  for (const t of THEMES) {
    assert.ok(t.name?.length, `${t.id} has no name`);
    assert.ok(t.description?.length, `${t.id} has no description`);
  }
});

test('the default theme exists', () => {
  assert.ok(THEME_IDS.includes(DEFAULT_THEME));
  assert.equal(getTheme(DEFAULT_THEME).id, DEFAULT_THEME);
});

test('an unknown theme falls back rather than returning undefined', () => {
  assert.equal(getTheme('does-not-exist').id, DEFAULT_THEME);
  assert.ok(palette('does-not-exist', 'dark').bg);
});

/**
 * Severity is the load-bearing signal in this UI — it is how you see that you
 * are about to be rate limited. A theme is allowed to restyle the chrome, but
 * never to make "fine" and "nearly out" look alike.
 */
test('severity colours stay distinct from each other in every theme and mode', () => {
  for (const t of THEMES) {
    for (const mode of ['light', 'dark']) {
      const { ok, warn, crit } = t[mode];
      assert.notEqual(ok, warn, `${t.id}.${mode}: ok and warn are identical`);
      assert.notEqual(warn, crit, `${t.id}.${mode}: warn and crit are identical`);
      assert.notEqual(ok, crit, `${t.id}.${mode}: ok and crit are identical`);
    }
  }
});

test('severity colours keep their conventional hues, including in Mono', () => {
  const hue = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (!d) return null;
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  for (const t of THEMES) {
    for (const mode of ['light', 'dark']) {
      const p = t[mode];
      assert.ok(hue(p.ok) > 80 && hue(p.ok) < 180, `${t.id}.${mode}: ok is not green (${hue(p.ok)}deg)`);
      assert.ok(hue(p.warn) > 20 && hue(p.warn) < 70, `${t.id}.${mode}: warn is not amber (${hue(p.warn)}deg)`);
      const critHue = hue(p.crit);
      assert.ok(critHue < 25 || critHue > 340, `${t.id}.${mode}: crit is not red (${critHue}deg)`);
    }
  }
});

// WCAG relative luminance; body text should clear 4.5:1.
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

test('text has real contrast against its background in every theme', () => {
  for (const t of THEMES) {
    for (const mode of ['light', 'dark']) {
      const p = t[mode];
      assert.ok(ratio(p.ink, p.bg) >= 4.5, `${t.id}.${mode}: ink on bg is ${ratio(p.ink, p.bg).toFixed(2)}:1`);
      assert.ok(ratio(p.ink, p.panel) >= 4.5, `${t.id}.${mode}: ink on panel is ${ratio(p.ink, p.panel).toFixed(2)}:1`);
      // Dimmed text is secondary, but must still be legible.
      assert.ok(ratio(p.inkDim, p.panel) >= 3, `${t.id}.${mode}: inkDim on panel is ${ratio(p.inkDim, p.panel).toFixed(2)}:1`);
    }
  }
});

test('no theme ever colours ordinary menu bar text without a plate', () => {
  // Painting straight onto the wallpaper, NSColor.labelColor (null) is the only
  // colour macOS guarantees is readable. A plate changes that — but only because
  // the plate is opaque and we measured the ink against it.
  for (const id of THEME_IDS) {
    for (const mode of ['light', 'dark']) {
      const c = menubarColors(id, mode, { scheme: 'neutral', fill: 'none' });
      assert.equal(c.normal.background, null);
      assert.equal(c.normal.text, null, `${id}.${mode}: unplated normal text must defer to the system`);
    }
  }
});

test('every menu bar chip is measurably readable', () => {
  // The guarantee the whole feature rests on: for any theme, scheme, fill and
  // system appearance, the ink the server picks clears WCAG AA on its plate.
  let worst = { ratio: Infinity };
  for (const id of THEME_IDS) {
    for (const scheme of MENUBAR_SCHEME_IDS) {
      for (const fill of MENUBAR_FILLS) {
        for (const mode of ['light', 'dark']) {
          const c = menubarColors(id, mode, { scheme, fill });
          for (const key of ['normal', 'warning', 'critical']) {
            const { background, text } = c[key];
            if (!background) { continue; }
            assert.ok(text, `${id}/${scheme}/${fill}/${mode}: a plate must carry derived ink`);
            const r = contrastRatio(text, background);
            if (r < worst.ratio) worst = { ratio: r, id, scheme, fill, mode, key };
            assert.ok(r >= 4.5,
              `${id}/${scheme}/${fill}/${mode}/${key}: ${r.toFixed(2)}:1 on ${background}`);
          }
        }
      }
    }
  }
  assert.ok(worst.ratio >= 4.5, 'a plate somewhere fell below AA');
});

test('readableInk picks by measurement, not by guess', () => {
  assert.equal(contrastRatio(readableInk('#ffffff'), '#ffffff') > 4.5, true);
  assert.equal(contrastRatio(readableInk('#000000'), '#000000') > 4.5, true);
  // A mid-tone is the interesting case: whichever way it falls, it must clear.
  for (const bg of ['#767676', '#808080', '#8a8a8a', '#c96442', '#38768f']) {
    assert.ok(contrastRatio(readableInk(bg), bg) >= 4.4, `${bg} got unreadable ink`);
  }
  assert.equal(readableInk(null), null, 'no plate means no derived ink');
});

test('turning severity off silences the plate but keeps it readable', () => {
  const on = menubarColors('ember', 'dark', { scheme: 'neutral', fill: 'solid', severity: true });
  const off = menubarColors('ember', 'dark', { scheme: 'neutral', fill: 'solid', severity: false });
  assert.notEqual(on.critical.background, on.normal.background, 'severity must change the plate');
  assert.equal(off.critical.background, off.normal.background, 'severity off means one plate');
  assert.ok(contrastRatio(off.critical.text, off.critical.background) >= 4.5);
});

test('gauge palettes stay inside the theme and track the percentage', () => {
  for (const id of THEME_IDS) {
    const p = palette(id, 'dark');
    assert.equal(gaugeColor(id, 'dark', 'severity', 10), p.ok);
    assert.equal(gaugeColor(id, 'dark', 'severity', 80), p.warn);
    assert.equal(gaugeColor(id, 'dark', 'severity', 95), p.crit);
    assert.equal(gaugeColor(id, 'dark', 'accent', 95), p.accent, 'accent ignores severity by design');
    // The gradient must be monotonic in luminance-independent terms: distinct
    // colours at distinct percentages, anchored to the same thresholds.
    assert.equal(gaugeColor(id, 'dark', 'gradient', 0), p.ok);
    assert.equal(gaugeColor(id, 'dark', 'gradient', 75), p.warn);
    assert.equal(gaugeColor(id, 'dark', 'gradient', 100), p.crit);
    assert.notEqual(gaugeColor(id, 'dark', 'gradient', 40), gaugeColor(id, 'dark', 'gradient', 60));
  }
});

test('every gauge style renders a bar of the right length', () => {
  for (const style of GAUGE_STYLES) {
    assert.equal([...renderTextBar(50, style, 10)].length, 10, `${style}: wrong width`);
    assert.equal([...renderTextBar(0, style, 10)].length, 10);
    assert.equal([...renderTextBar(100, style, 10)].length, 10);
    // Out of range input is clamped rather than producing a ragged bar.
    assert.equal([...renderTextBar(140, style, 10)].length, 10);
    assert.equal([...renderTextBar(-20, style, 10)].length, 10);
    assert.notEqual(renderTextBar(0, style, 10), renderTextBar(100, style, 10));
  }
});

test('the catalogs give the settings page everything it needs to preview', () => {
  const schemes = menubarCatalog();
  assert.equal(schemes.length, MENUBAR_SCHEMES.length);
  for (const s of schemes) {
    assert.ok(s.name && s.description);
    for (const f of s.fills) {
      if (!f.light) continue;   // the 'system' scheme has no plate to preview
      assert.ok(f.light.background && f.light.text);
      assert.ok(f.dark.background && f.dark.text);
    }
  }
  const g = gaugeCatalog();
  assert.deepEqual(g.styles.map((x) => x.id), GAUGE_STYLES);
  assert.deepEqual(g.palettes.map((x) => x.id), GAUGE_PALETTES);
  for (const st of g.styles) assert.ok(st.sample.length > 0, `${st.id} has no sample bar`);
  for (const pl of g.palettes) assert.equal(pl.stops.length, 4);
});

test('the catalog carries both palettes for every theme', () => {
  const cat = themeCatalog();
  assert.equal(cat.length, THEMES.length);
  for (const t of cat) {
    assert.ok(t.light.bg && t.dark.bg);
    assert.ok(t.name && t.description);
  }
});

/* ---------- config integration ---------- */

test('appearance defaults are sane', () => {
  assert.equal(DEFAULTS.appearance.theme, DEFAULT_THEME);
  assert.equal(DEFAULTS.appearance.mode, 'system');
  // No plate by default: a menu bar item that paints its own background is a
  // deliberate choice, not something to spring on someone at first launch.
  assert.equal(DEFAULTS.appearance.menubar.fill, 'none');
  assert.equal(DEFAULTS.appearance.gauge.style, 'blocks');
  assert.equal(DEFAULTS.appearance.gauge.palette, 'severity');
});

test('every valid appearance combination survives validation unchanged', () => {
  for (const theme of THEME_IDS) {
    for (const mode of APPEARANCES) {
      for (const metric of METRICS) {
        for (const scope of SCOPES) {
          for (const scheme of MENUBAR_SCHEME_IDS) {
            for (const fill of MENUBAR_FILLS) {
              for (const style of GAUGE_STYLES) {
                for (const gPalette of GAUGE_PALETTES) {
                  const want = {
                    theme, mode, metric, scope,
                    menubar: { scheme, fill, severity: true },
                    gauge: { style, palette: gPalette },
                  };
                  const { config, errors } = validate({ appearance: want });
                  assert.deepEqual(errors, [], `${JSON.stringify(want)} produced ${errors}`);
                  assert.deepEqual(config.appearance, want);
                }
              }
            }
          }
        }
      }
    }
  }
});

test('a config written by the previous version keeps its intent', () => {
  // menubarStyle: 'mono' meant "do not colour the menu bar". That maps onto the
  // new model as severity off, not as a silently dropped setting.
  const { config, errors } = validate({ appearance: { theme: 'slate', menubarStyle: 'mono' } });
  assert.deepEqual(errors, [], 'a legacy key must migrate, not error');
  assert.equal(config.appearance.menubar.severity, false);
  assert.equal(config.appearance.menubarStyle, undefined, 'the dead key must not linger');

  const colored = validate({ appearance: { menubarStyle: 'color' } });
  assert.equal(colored.config.appearance.menubar.severity, true);
});

test('the menu bar defaults to showing how much session is left', () => {
  assert.equal(DEFAULTS.appearance.metric, 'remaining');
  assert.equal(DEFAULTS.appearance.scope, 'session');
});

test('invalid metric and scope are reported and defaulted', () => {
  const { config, errors } = validate({ appearance: { metric: 'sideways', scope: 'galaxy' } });
  assert.equal(config.appearance.metric, 'remaining');
  assert.equal(config.appearance.scope, 'session');
  assert.equal(errors.length, 2);
});

test('invalid appearance values are reported and replaced with defaults', () => {
  const { config, errors } = validate({
    appearance: {
      theme: 'neon', mode: 'sepia',
      menubar: { scheme: 'rainbow', fill: 'flood' },
      gauge: { style: 'zigzag', palette: 'chartreuse' },
    },
  });
  assert.equal(errors.length, 6, `expected one error per bad field, got: ${errors.join(' | ')}`);
  assert.equal(config.appearance.metric, 'remaining');
  assert.deepEqual(config.appearance, DEFAULTS.appearance);
});

test('a partial appearance patch keeps the other fields', () => {
  const { config } = validate({ appearance: { theme: 'mono' } });
  assert.equal(config.appearance.theme, 'mono');
  assert.equal(config.appearance.mode, 'system');
});

test('dropdown colours are legible on the menu material', () => {
  // The menu, unlike the menu bar, has a predictable near-opaque backing that
  // follows the system appearance. That is the entire justification for theming
  // it at all, so the assumption gets measured rather than assumed.
  for (const id of THEME_IDS) {
    for (const mode of ['light', 'dark']) {
      const m = menuColors(id, mode, { scheme: 'violet' });
      assert.equal(m.material, MENU_MATERIAL[mode]);
      assert.ok(contrastRatio(m.ink, m.material) >= 4.5,
        `${id}.${mode}: menu ink is ${contrastRatio(m.ink, m.material).toFixed(2)}:1`);
      // Dimmed text and the accent are secondary, so the 3:1 UI bar applies.
      assert.ok(contrastRatio(m.inkDim, m.material) >= 3,
        `${id}.${mode}: menu inkDim is ${contrastRatio(m.inkDim, m.material).toFixed(2)}:1`);
      assert.ok(contrastRatio(m.accent, m.material) >= 3,
        `${id}.${mode}: menu accent is ${contrastRatio(m.accent, m.material).toFixed(2)}:1`);
    }
  }
});

test('the dropdown header keeps the scheme even with no menu bar plate', () => {
  // "No plate" exists because the wallpaper is unpredictable. A menu has a real
  // background, so that reason does not carry over — the colour you picked
  // should still be visible when you open the menu.
  for (const scheme of MENUBAR_SCHEME_IDS) {
    for (const mode of ['light', 'dark']) {
      const bar = menubarColors('ember', mode, { scheme, fill: 'none' });
      assert.equal(bar.normal.background, null, 'the bar itself must stay unplated');

      const m = menuColors('ember', mode, { scheme, fill: 'none' });
      if (scheme === 'system') {
        assert.equal(m.headerBackground, null, 'the system scheme has no colour to show');
        continue;
      }
      assert.ok(m.headerBackground, `${scheme}.${mode}: the dropdown lost the scheme`);
      assert.ok(contrastRatio(m.headerText, m.headerBackground) >= 4.5,
        `${scheme}.${mode}: header text is unreadable on its own plate`);
    }
  }
});
