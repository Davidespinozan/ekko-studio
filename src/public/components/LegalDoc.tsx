import type { ReactNode } from 'react';

/**
 * Layout compartido de las páginas legales (Términos, Aviso de Privacidad).
 * Prosa centrada y legible sobre el tema oscuro. El header público (logo + nav)
 * lo pone PublicLayout; aquí va solo el documento.
 */
export function LegalDoc({
  eyebrow,
  titulo,
  actualizado,
  children
}: {
  eyebrow: string;
  titulo: string;
  actualizado: string;
  children: ReactNode;
}) {
  return (
    <div className="ek-legal">
      <p className="ek-eyebrow ek-eyebrow--mustard" style={{ fontSize: '10px', marginBottom: '8px', marginTop: '24px' }}>
        {eyebrow}
      </p>
      <h1
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: '30px',
          fontWeight: 700,
          letterSpacing: '-0.03em',
          color: 'var(--ek-ink)',
          margin: '0 0 6px'
        }}
      >
        {titulo}
      </h1>
      <p className="ek-legal-lead">Última actualización: {actualizado}</p>
      {children}
    </div>
  );
}
