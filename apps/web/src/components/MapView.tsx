import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  color: string;
  /** Short text shown on hover */
  title: string;
  /** Plain-text lines shown in the popup (escaped) */
  popup?: { heading: string; lines: string[]; link?: { href: string; label: string } };
}

const MEXICO: L.LatLngTuple = [23.6, -102.5];

function dotIcon(color: string, active: boolean) {
  const size = active ? 22 : 16;
  return L.divIcon({
    className: '',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    html: `<span style="display:block;width:${size}px;height:${size}px;border-radius:9999px;background:${color};border:3px solid white;box-shadow:0 1px 4px rgba(15,23,42,.45)"></span>`,
  });
}

function clusterIcon(count: number, color: string) {
  const size = count < 10 ? 30 : 36;
  return L.divIcon({
    className: 'map-cluster',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    html: `<span data-count="${count}" style="display:flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:9999px;background:${color};color:white;font:600 13px system-ui,sans-serif;border:3px solid white;box-shadow:0 0 0 4px ${color}55,0 1px 4px rgba(15,23,42,.45)">${count}</span>`,
  });
}

const CLUSTER_PX = 30;

/** Greedy pixel-distance grouping at the map's current zoom (no clustering when zoomed in close). */
function clusterMarkers(m: L.Map, list: MapMarker[]): MapMarker[][] {
  const z = m.getZoom();
  if (z >= 15) return list.map((x) => [x]);
  const groups: { pt: L.Point; items: MapMarker[] }[] = [];
  for (const mk of list) {
    const pt = m.project([mk.lat, mk.lng], z);
    const g = groups.find((x) => x.pt.distanceTo(pt) < CLUSTER_PX);
    if (g) g.items.push(mk);
    else groups.push({ pt, items: [mk] });
  }
  return groups.map((g) => g.items);
}

function popupNode(p: NonNullable<MapMarker['popup']>): HTMLElement {
  const root = document.createElement('div');
  root.style.minWidth = '180px';
  const h = document.createElement('div');
  h.style.fontWeight = '600';
  h.textContent = p.heading;
  root.appendChild(h);
  for (const line of p.lines) {
    const d = document.createElement('div');
    d.style.color = '#475569';
    d.style.fontSize = '12px';
    d.textContent = line;
    root.appendChild(d);
  }
  if (p.link) {
    const a = document.createElement('a');
    a.href = p.link.href;
    a.textContent = p.link.label;
    a.style.cssText = 'display:inline-block;margin-top:6px;font-weight:600;color:#0f766e';
    root.appendChild(a);
  }
  return root;
}

/**
 * Small imperative wrapper around Leaflet with OpenStreetMap tiles.
 * - markers: dots coloured by category; clicking one calls onSelect
 * - picker mode: clicking the map calls onPick(lat, lng)
 */
export function MapView({
  markers,
  selectedId,
  onSelect,
  onPick,
  userLocation,
  className = 'h-80',
  fitKey,
}: {
  markers: MapMarker[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  onPick?: (lat: number, lng: number) => void;
  userLocation?: { lat: number; lng: number } | null;
  className?: string;
  /** Change this value to re-fit the map to the markers (e.g. after filtering) */
  fitKey?: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const userLayer = useRef<L.LayerGroup | null>(null);
  const refs = useRef(new Map<string, { marker: L.Marker; color: string }>());
  const cbs = useRef({ onSelect, onPick });
  cbs.current = { onSelect, onPick };
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const markersRef = useRef(markers);
  markersRef.current = markers;

  /**
   * (Re)draws markers for the current zoom. Nearby pins are grouped into a count bubble so
   * dense cities stay readable at country level; tapping a bubble zooms into its pins.
   * Runs imperatively (also on zoomend) so the selected pin's popup can reopen right after.
   */
  const draw = useRef(() => {});
  draw.current = () => {
    const m = map.current;
    const lg = layer.current;
    if (!m || !lg) return;
    lg.clearLayers();
    refs.current.clear();
    for (const group of clusterMarkers(m, markersRef.current)) {
      if (group.length === 1) {
        const mk = group[0]!;
        const active = mk.id === selectedRef.current;
        const marker = L.marker([mk.lat, mk.lng], {
          icon: dotIcon(mk.color, active),
          title: mk.title,
          zIndexOffset: active ? 1000 : 0,
          keyboard: true,
        });
        if (mk.popup) marker.bindPopup(popupNode(mk.popup));
        marker.on('click', () => cbs.current.onSelect?.(mk.id));
        marker.addTo(lg);
        refs.current.set(mk.id, { marker, color: mk.color });
      } else {
        const bounds = L.latLngBounds(group.map((x) => [x.lat, x.lng] as L.LatLngTuple));
        const c = bounds.getCenter();
        L.marker(c, {
          icon: clusterIcon(group.length, group[0]!.color),
          title: group.map((x) => x.title).join(' · '),
          keyboard: true,
        })
          .on('click', () => m.fitBounds(bounds.pad(0.3), { maxZoom: 16 }))
          .addTo(lg);
      }
    }
  };

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current, { center: MEXICO, zoom: 5, scrollWheelZoom: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(m);
    layer.current = L.layerGroup().addTo(m);
    userLayer.current = L.layerGroup().addTo(m);
    m.on('click', (e: L.LeafletMouseEvent) => cbs.current.onPick?.(e.latlng.lat, e.latlng.lng));
    m.on('zoomend', () => draw.current());
    map.current = m;
    // The container may be hidden or resized later (mobile list/map toggle, grid layouts).
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      m.remove();
      map.current = null;
    };
  }, []);

  // Fit to markers when the result set changes
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    m.invalidateSize();
    const pts = markers.map((x) => [x.lat, x.lng] as L.LatLngTuple);
    if (pts.length === 1) m.setView(pts[0]!, Math.max(m.getZoom(), 15));
    else if (pts.length > 1) m.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 14 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  // Redraw when the marker set changes (selection only restyles, so an open popup stays open)
  useEffect(() => draw.current(), [markers]);

  useEffect(() => {
    for (const [id, { marker, color }] of refs.current) {
      const active = id === selectedId;
      marker.setIcon(dotIcon(color, active));
      marker.setZIndexOffset(active ? 1000 : 0);
    }
  }, [selectedId, markers]);

  // Focus selected marker (it may be inside a bubble until we zoom in)
  useEffect(() => {
    const m = map.current;
    const target = markersRef.current.find((x) => x.id === selectedId);
    if (!m || !target) return;
    const open = () => refs.current.get(target.id)?.marker.openPopup();
    m.flyTo([target.lat, target.lng], Math.max(m.getZoom(), 15), { duration: 0.5 });
    m.once('moveend', open);
    open();
  }, [selectedId]);

  // User location
  useEffect(() => {
    const ul = userLayer.current;
    if (!ul) return;
    ul.clearLayers();
    if (userLocation) {
      L.circleMarker([userLocation.lat, userLocation.lng], {
        radius: 8, color: '#2563eb', fillColor: '#3b82f6', fillOpacity: 0.9, weight: 3,
      }).addTo(ul);
    }
  }, [userLocation]);

  return <div ref={el} className={`z-0 w-full overflow-hidden rounded-xl border border-slate-200 ${className}`} role="region" aria-label="map" />;
}

/** Category colours for map dots and legend chips. */
export const TYPE_COLORS: Record<string, string> = {
  nutrition: '#16a34a',
  medical: '#2563eb',
  dental: '#0891b2',
  psychology: '#7c3aed',
  physiotherapy: '#0d9488',
  cosmetology: '#db2777',
  beauty_salon: '#e11d48',
  barbershop: '#475569',
  spa: '#a855f7',
  veterinary: '#65a30d',
  restaurant: '#ea580c',
  cafe: '#a16207',
  bar: '#b91c1c',
  other: '#64748b',
};

/** Great-circle distance in km. */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
