import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Scroll-reveal: el contenido sube + aparece cuando entra al viewport. Usa las
 * clases `.reveal`/`.reveal.visible` de ekko.css (que respetan
 * prefers-reduced-motion → queda visible sin animación). Se revela una sola vez.
 * `delay` (1–3) escalona la entrada de hermanos (stagger). Patrón tomado de SALA.
 */
export function Reveal({
  children,
  delay = 0,
  className = '',
  style
}: {
  children: ReactNode;
  delay?: 0 | 1 | 2 | 3;
  className?: string;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setVisible(true);
            obs.disconnect();
            break;
          }
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const cls = ['reveal', visible ? 'visible' : '', delay ? `reveal-delay-${delay}` : '', className]
    .filter(Boolean)
    .join(' ');

  return (
    <div ref={ref} className={cls} style={style}>
      {children}
    </div>
  );
}
