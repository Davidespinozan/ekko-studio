// ============================================================================
// celebrar() — micro-celebración de confetti al completar una acción feliz
// (p. ej. confirmar una reserva). Sin dependencias: inyecta piezas en el DOM
// con las clases de ekko.css y se autolimpia. Respeta prefers-reduced-motion
// y es no-op fuera del navegador (SSR / tests sin DOM).
// ============================================================================

const COLORES = ['#e5b829', '#f5f1e8', '#efc23f', '#ffffff'];

export function celebrar(cantidad = 42): void {
  if (typeof document === 'undefined' || !document.body) return;
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  if (reduce) return;

  const layer = document.createElement('div');
  layer.className = 'ek-confetti-layer';
  layer.setAttribute('aria-hidden', 'true');

  for (let i = 0; i < cantidad; i++) {
    const p = document.createElement('span');
    p.className = 'ek-confetti-piece';
    const size = 6 + Math.random() * 6;
    p.style.left = `${Math.random() * 100}%`;
    p.style.width = `${size}px`;
    p.style.height = `${size * 0.6}px`;
    p.style.background = COLORES[i % COLORES.length];
    p.style.setProperty('--drift', `${(Math.random() * 2 - 1) * 90}px`);
    p.style.setProperty('--rot', `${Math.random() * 540}deg`);
    p.style.animationDuration = `${1.4 + Math.random() * 0.9}s`;
    p.style.animationDelay = `${Math.random() * 0.25}s`;
    layer.appendChild(p);
  }

  document.body.appendChild(layer);
  window.setTimeout(() => layer.remove(), 2600);
}
