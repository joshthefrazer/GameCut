/**
 * Framing guides drawn over the preview.
 *
 * Beyond the usual title/action-safe boxes, a 16:9 project also shows the
 * 9:16 crop window — so a landscape gameplay cut can be framed with the
 * vertical repost in mind instead of being re-framed later.
 */
export function drawGuides(svg, { w, h, aspect, guides, grid }) {
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.innerHTML = '';
  const add = (tag, attrs) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.appendChild(el);
    return el;
  };

  if (grid) {
    for (let i = 1; i < 3; i++) {
      add('line', { x1: (w * i) / 3, y1: 0, x2: (w * i) / 3, y2: h, stroke: 'rgba(255,255,255,.22)', 'stroke-width': 1 });
      add('line', { x1: 0, y1: (h * i) / 3, x2: w, y2: (h * i) / 3, stroke: 'rgba(255,255,255,.22)', 'stroke-width': 1 });
    }
  }

  if (!guides) return;

  const box = (frac, stroke, dash) => add('rect', {
    x: (w * (1 - frac)) / 2, y: (h * (1 - frac)) / 2,
    width: w * frac, height: h * frac,
    fill: 'none', stroke, 'stroke-width': 1, 'stroke-dasharray': dash || 'none',
  });
  box(0.93, 'rgba(255,255,255,.28)');
  box(0.90, 'rgba(255,255,255,.16)', '5 5');

  // centre cross
  const c = 'rgba(255,255,255,.30)';
  add('line', { x1: w / 2 - 12, y1: h / 2, x2: w / 2 + 12, y2: h / 2, stroke: c, 'stroke-width': 1 });
  add('line', { x1: w / 2, y1: h / 2 - 12, x2: w / 2, y2: h / 2 + 12, stroke: c, 'stroke-width': 1 });

  // vertical repost window inside a landscape project
  if (aspect === '16:9') {
    const vw = h * (9 / 16);
    add('rect', {
      x: (w - vw) / 2, y: 0, width: vw, height: h,
      fill: 'none', stroke: 'rgba(34,211,238,.55)', 'stroke-width': 1.5, 'stroke-dasharray': '8 6',
    });
    const label = add('text', {
      x: (w - vw) / 2 + 6, y: 16,
      fill: 'rgba(34,211,238,.9)', 'font-size': 11, 'font-family': 'ui-monospace, monospace',
    });
    label.textContent = '9:16 SAFE';
  }
}
