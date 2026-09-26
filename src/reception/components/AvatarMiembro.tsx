/**
 * Foto del miembro (o sus iniciales) para las tarjetas de mostrador.
 * Recepción reconoce a la gente por la cara antes que por el nombre: en Hoy y
 * en el padrón la foto acelera el "¿es él?" al llegar (paridad SALA, R7).
 */
export function AvatarMiembro({
  nombre,
  url,
  size = 36
}: {
  nombre: string;
  url: string | null | undefined;
  size?: number;
}) {
  const estilo = {
    width: size,
    height: size,
    borderRadius: '50%',
    flexShrink: 0,
    objectFit: 'cover' as const,
    display: 'block'
  };
  if (url) {
    return <img src={url} alt="" aria-hidden="true" style={estilo} />;
  }
  const iniciales = nombre
    .split(/[\s@]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <div
      aria-hidden="true"
      style={{
        ...estilo,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--ek-mustard-soft)',
        color: 'var(--ek-mustard)',
        fontFamily: 'var(--ek-font-display)',
        fontWeight: 700,
        fontSize: Math.round(size * 0.38)
      }}
    >
      {iniciales || '?'}
    </div>
  );
}
