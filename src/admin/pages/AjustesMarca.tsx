import { Link } from 'react-router-dom';

export default function AjustesMarca() {
  return (
    <div className="adm-page">
      <p className="ek-eyebrow" style={{ marginBottom: '4px' }}>AJUSTES</p>
      <h1
        style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: 'clamp(28px, 5vw, 40px)',
          fontWeight: 700,
          letterSpacing: '-0.04em',
          margin: 0,
          marginBottom: '32px'
        }}
      >
        Marca
      </h1>

      <div
        className="ek-card"
        style={{
          padding: 'clamp(40px, 8vw, 80px) clamp(24px, 6vw, 64px)',
          textAlign: 'center',
          opacity: 0.85
        }}
      >
        <p
          style={{
            fontSize: '56px',
            lineHeight: 1,
            margin: 0,
            marginBottom: '20px'
          }}
        >
          🎨
        </p>
        <p
          className="ek-eyebrow ek-eyebrow--mustard"
          style={{ marginBottom: '8px' }}
        >
          PRÓXIMAMENTE — SPRINT D
        </p>
        <h2
          style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: 'clamp(20px, 3vw, 26px)',
            fontWeight: 700,
            letterSpacing: '-0.03em',
            margin: 0,
            marginBottom: '20px'
          }}
        >
          Personaliza la identidad visual de tu marca
        </h2>

        <p
          style={{
            fontSize: '14px',
            color: 'var(--ek-ink-muted)',
            lineHeight: 1.6,
            maxWidth: '420px',
            margin: '0 auto 28px'
          }}
        >
          Aquí vas a poder configurar:
        </p>

        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: '0 auto 32px',
            maxWidth: '360px',
            textAlign: 'left',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px'
          }}
        >
          {[
            'Logo de tu marca (versión clara y oscura)',
            'Imagen para compartir en redes (Open Graph)',
            'Colores principales y de acento',
            'Favicon dinámico por tenant'
          ].map((item) => (
            <li
              key={item}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '8px',
                fontSize: '14px',
                color: 'var(--ek-ink-muted)'
              }}
            >
              <span style={{ color: 'var(--ek-mustard)' }}>•</span>
              {item}
            </li>
          ))}
        </ul>

        <p
          style={{
            fontSize: '12px',
            color: 'var(--ek-ink-faint)',
            lineHeight: 1.6,
            maxWidth: '460px',
            margin: '0 auto 24px'
          }}
        >
          Por ahora, EKKO usa la paleta &quot;Mostaza Ink&quot; como diseño base.
          Cuando esta funcionalidad esté lista, podrás personalizarla desde aquí.
        </p>

        <Link
          to="/admin"
          className="ek-cta ek-cta--secondary"
          style={{ padding: '12px 24px', fontSize: '13px' }}
        >
          Volver al inicio
        </Link>
      </div>
    </div>
  );
}
