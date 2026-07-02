import { useRef, useEffect, type ReactNode, type CSSProperties, type MouseEvent } from 'react';

/**
 * CTA "magnético": el botón sigue sutilmente al cursor y vuelve suave al salir.
 * Renderiza un <a> (los CTAs del landing son links). Solo desktop (mousemove);
 * en táctil no se dispara y queda el botón normal. Respeta prefers-reduced-motion.
 * Anima solo transform con el easing premium de EKKO. Patrón tomado de SALA.
 */
export function MagneticButton({
  href,
  children,
  className = '',
  style,
  strength = 0.26,
  target,
  rel,
  onClick
}: {
  href: string;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Intensidad del seguimiento (0.2–0.3). Default 0.26. */
  strength?: number;
  target?: string;
  rel?: string;
  onClick?: () => void;
}) {
  const ref = useRef<HTMLAnchorElement>(null);
  const reduced = useRef(false);

  useEffect(() => {
    reduced.current =
      typeof window !== 'undefined' &&
      (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  }, []);

  const onMove = (e: MouseEvent<HTMLAnchorElement>) => {
    const el = ref.current;
    if (!el || reduced.current) return;
    const { left, top, width, height } = el.getBoundingClientRect();
    const x = (e.clientX - left - width / 2) * strength;
    const y = (e.clientY - top - height / 2) * strength;
    el.style.transform = `translate(${x}px, ${y}px)`;
  };

  const onLeave = () => {
    if (ref.current) ref.current.style.transform = 'translate(0, 0)';
  };

  return (
    <a
      ref={ref}
      href={href}
      target={target}
      rel={rel}
      onClick={onClick}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      className={className}
      style={{
        transition:
          'transform 0.35s var(--ek-ease-premium), box-shadow 0.28s var(--ek-ease-premium), filter 0.28s var(--ek-ease-premium)',
        ...style
      }}
    >
      {children}
    </a>
  );
}
