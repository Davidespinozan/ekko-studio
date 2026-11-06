/**
 * Efectos de la landing (Fase 1 premium). Funciones puras y pequeños
 * instaladores que devuelven su propia limpieza, para poder probarlos sin
 * montar toda la página. Nada de esto toca datos: es solo presentación.
 */

/** Palabras del título del hero, para revelarlas una por una. */
export function partirPalabras(texto: string | null | undefined): string[] {
  return (texto ?? '').split(/\s+/).filter(Boolean);
}

/** Quita la flecha final del texto de un botón ("Ver planes →"): el ícono animado la sustituye. */
export function sinFlecha(texto: string | null | undefined): string {
  return (texto ?? '').replace(/\s*(→|->|›|»)\s*$/u, '').trim();
}

/** La navegación se vuelve sólida en cuanto el hero empieza a irse. */
export function navSolida(scrollY: number): boolean {
  return scrollY > 24;
}

/** Avance de lectura 0–1 a partir del scroll, el alto del documento y el visible. */
export function progresoScroll(scrollY: number, altoDocumento: number, altoVisible: number): number {
  const maximo = altoDocumento - altoVisible;
  if (maximo <= 0) return 0;
  return Math.min(1, Math.max(0, scrollY / maximo));
}

/** Posición del cursor relativa a una caja, en px (para `--x/--y` y `--mx/--my`). */
export function posicionRelativa(
  e: { clientX: number; clientY: number },
  r: { left: number; top: number }
): { x: number; y: number } {
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

/** Un solo oyente delegado: cada `.ek-glow` recibe `--x/--y` cuando el cursor pasa sobre ella. */
export function instalarBrilloTarjetas(raiz: HTMLElement | null): () => void {
  if (!raiz) return () => {};
  const onMove = (e: PointerEvent) => {
    const objetivo = e.target as Element | null;
    const tarjeta = objetivo?.closest?.('.ek-glow') as HTMLElement | null;
    if (!tarjeta) return;
    const { x, y } = posicionRelativa(e, tarjeta.getBoundingClientRect());
    tarjeta.style.setProperty('--x', `${x}px`);
    tarjeta.style.setProperty('--y', `${y}px`);
  };
  raiz.addEventListener('pointermove', onMove);
  return () => raiz.removeEventListener('pointermove', onMove);
}

/** El foco del hero sigue al cursor (`--mx/--my`). */
export function instalarSpotlight(hero: HTMLElement | null): () => void {
  if (!hero) return () => {};
  const onMove = (e: PointerEvent) => {
    const { x, y } = posicionRelativa(e, hero.getBoundingClientRect());
    hero.style.setProperty('--mx', `${x}px`);
    hero.style.setProperty('--my', `${y}px`);
  };
  hero.addEventListener('pointermove', onMove);
  return () => hero.removeEventListener('pointermove', onMove);
}

/** Barra de progreso de lectura (2 px arriba), pintada como mucho una vez por cuadro. */
export function instalarProgresoScroll(barra?: HTMLElement | null): () => void {
  const el = barra ?? document.querySelector<HTMLElement>('.ek-progreso');
  if (!el) return () => {};
  let raf = 0;
  const pintar = () => {
    raf = 0;
    const p = progresoScroll(window.scrollY, document.documentElement.scrollHeight, window.innerHeight);
    el.style.transform = `scaleX(${p.toFixed(4)})`;
  };
  const onScroll = () => {
    if (!raf) raf = requestAnimationFrame(pintar);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  pintar();
  return () => {
    window.removeEventListener('scroll', onScroll);
    if (raf) cancelAnimationFrame(raf);
  };
}
