// Where models run: a live map of known serving sites from the registry, shared by the home and
// Europe pages. Markup: <div class="sitemap" hidden data-countries="FR,DE,..." data-label="Europe">
// and a <p data-where-sum> holding a snapshot line. The summary refreshes from the registry;
// Leaflet and the map tiles load only when the map scrolls into view, and the snapshot line
// stays if anything fails.
(() => {
  const REG = 'https://registry.opennodes.io';
  const LEAFLET = {
    css: ['https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css', 'sha512-h9FcoyWjHcOcmEVkxOfTLnmZFWIH0iZhZT1H2TbOq55xssQGEJHEaIm+PgoUaZbRvQTNTluNOEfb1ZRy6D3BOw=='],
    js: ['https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js', 'sha512-puJW3E/qXDqYp9IfhAI54BJEaWIfloJ7JWs7OeD5i6ruC9JZL1gERT1wjtwXFlh7CjE7ZJ+/vcRZRkIYIb6p4g=='],
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const plural = (n, w, many = w + 's') => `${n.toLocaleString('en-US')} ${n === 1 ? w : many}`;
  const loadLeaflet = () => new Promise((resolve, reject) => {
    const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: LEAFLET.css[0], integrity: LEAFLET.css[1], crossOrigin: 'anonymous', referrerPolicy: 'no-referrer' });
    const js = Object.assign(document.createElement('script'), { src: LEAFLET.js[0], integrity: LEAFLET.js[1], crossOrigin: 'anonymous', referrerPolicy: 'no-referrer' });
    js.onload = () => resolve(window.L);
    js.onerror = () => reject(new Error('map library did not load'));
    document.head.append(css, js);
  });

  /** "Live from the registry: 23 sites in 2 countries — Canada, 20 sites from 14 providers; ..." */
  function summary(sites, label) {
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    const byCountry = new Map();
    for (const s of sites) {
      const c = byCountry.get(s.country) ?? { sites: 0, providers: new Set() };
      c.sites++; c.providers.add(s.node_id);
      byCountry.set(s.country, c);
    }
    if (!sites.length) return `Live from the registry: no sites${label ? ' in ' + label : ''} are mapped yet.`;
    // The six largest countries by name; the rest as a count, so the line stays one or two lines.
    const rows = [...byCountry].sort((a, b) => b[1].sites - a[1].sites).slice(0, 6)
      .map(([c, v]) => `${names.of(c) ?? c}, ${plural(v.sites, 'site')} from ${plural(v.providers.size, 'provider')}`);
    const more = byCountry.size - rows.length;
    const planned = sites.filter((s) => s.status === 'planned').length;
    return `Live from the registry: ${plural(sites.length, 'site')} in ${plural(byCountry.size, 'country', 'countries')}${label ? ' in ' + label : ''}`
      + `${planned ? ` (${sites.length - planned} live, ${planned} planned)` : ''} — ${rows.join('; ')}${more ? `; and ${plural(more, 'more country', 'more countries')}` : ''}.`;
  }

  async function draw(box, sites) {
    const tiles = (await (await fetch(REG + '/v0/health')).json()).map;
    if (!tiles) throw new Error('the registry has no map tiles configured');
    const L = await loadLeaflet();
    const [lat0, lon0, zoom0] = (box.dataset.view ?? '50,-95,3').split(',').map(Number);
    const map = L.map(box, { worldCopyJump: true, scrollWheelZoom: false }).setView([lat0, lon0], zoom0);
    L.tileLayer(tiles.tiles, { attribution: tiles.attribution, maxZoom: tiles.max_zoom ?? 19 }).addTo(map);
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    // One marker per point: sites in the same city share it.
    const groups = new Map();
    for (const s of sites.filter((x) => x.geo)) {
      const key = s.geo.lat.toFixed(3) + ',' + s.geo.lon.toFixed(3);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
    const bounds = [];
    for (const group of groups.values()) {
      const { lat, lon } = group[0].geo;
      const models = group.reduce((n, s) => n + s.models.length, 0);
      const planned = group.every((s) => s.status === 'planned');
      L.circleMarker([lat, lon], {
        radius: Math.min(22, 6 + Math.sqrt(models) * 2.2), color: accent, weight: 2, fillColor: accent,
        fillOpacity: group.every((s) => s.geo.derived) ? 0 : 0.55, dashArray: planned ? '4 3' : null,
      }).bindPopup(group.map((s) => `<div class="site"><b>${esc(s.provider)}</b>${s.operator_country ? ` (${esc(s.operator_country)})` : ''}<br>
        ${esc(s.site ?? 'site not named')} · ${esc(s.region)} · ${esc(s.status)} · ${esc(s.basis)}
        ${s.geo.derived ? `<br><i>Approximate: only the ${esc(s.geo.precision)} is known</i>` : ''}
        <br>${s.models.length ? esc(s.models.slice(0, 6).map((m) => m.name).join(', ')) + (s.models.length > 6 ? ` +${s.models.length - 6} more` : '') : esc(s.models_note ?? 'no models listed')}
        ${s.source === 'seed' ? '' : `<br><a href="${REG}/#/node/${encodeURIComponent(s.node_id)}">node card</a>`}</div>`).join(''), { maxWidth: 300, maxHeight: 300 })
        .bindTooltip(`${plural(group.length, 'site')} · ${plural(models, 'model')}`)
        .addTo(map);
      bounds.push([lat, lon]);
    }
    if (bounds.length) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 5 });
  }

  const box = document.querySelector('.sitemap');
  const sum = document.querySelector('[data-where-sum]');
  if (!box || !('IntersectionObserver' in window)) return;
  const only = box.dataset.countries ? new Set(box.dataset.countries.split(',')) : null;
  const seen = new IntersectionObserver(async ([e]) => {
    if (!e.isIntersecting) return;
    seen.disconnect();
    // Show the empty frame at once so the page does not jump when the map arrives.
    box.hidden = false;
    try {
      const j = await (await fetch(REG + '/v0/locations')).json();
      const sites = only ? j.sites.filter((s) => only.has(s.country)) : j.sites;
      if (sum) sum.textContent = summary(sites, box.dataset.label);
      await draw(box, sites);
    } catch { box.hidden = true; /* keep the snapshot line and the links */ }
  }, { rootMargin: '200px' });
  // The section, not the hidden map, is what scrolls into view.
  seen.observe(box.closest('section') ?? box);
})();
