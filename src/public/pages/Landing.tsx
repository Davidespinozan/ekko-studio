import { useState } from 'react';
import { Link } from 'react-router-dom';
import EstudioModal, { type EstudioInfo } from '../components/EstudioModal';

const ESTUDIOS: EstudioInfo[] = [
  {
    slug: 'estudio-1',
    nombre: 'Estudio 1',
    tier: 'basica',
    capacidad: 'Hasta 3 personas',
    contenido: ['Podcast', 'Video', 'Entrevistas'],
    descripcion: 'Espacio versátil con iluminación cálida y fondo neutro de madera. Atmósfera profesional pero accesible. Ideal para contenido conversacional y entrevistas.',
    estiloVisual: 'Iluminación cálida, fondo neutro madera, atmósfera profesional pero accesible.',
    equipoIncluido: [
      'Cámara Sony A7 IV',
      'Micrófono Shure SM7B',
      'Iluminación LED profesional',
      'Pantalla verde opcional',
      'Audio Interface profesional'
    ]
  },
  {
    slug: 'estudio-2',
    nombre: 'Estudio 2',
    tier: 'basica',
    capacidad: 'Hasta 3 personas',
    contenido: ['Video', 'Cursos', 'Tutoriales'],
    descripcion: 'Espacio versátil con fondo intercambiable, ideal para contenido educativo y reviews. Setup pensado para creadores que producen variedad de contenido.',
    estiloVisual: 'Espacio versátil con fondo intercambiable, ideal para contenido educativo y reviews.',
    equipoIncluido: [
      'Cámara Sony A7 IV',
      'Micrófono Rode NT-USB',
      'Iluminación LED ajustable',
      'Audio Interface',
      'Trípode profesional'
    ]
  },
  {
    slug: 'black',
    nombre: 'Black',
    tier: 'pro',
    capacidad: 'Hasta 5 personas',
    contenido: ['Producciones', 'Cinema', 'Comerciales', 'Music Videos'],
    descripcion: 'Estudio premium con estética cinematográfica. Iluminación dramática controlable. Diseñado para producciones de alto nivel donde cada detalle importa.',
    estiloVisual: 'Estudio premium con estética cinematográfica. Iluminación dramática controlable. Diseñado para producciones de alto nivel.',
    equipoIncluido: [
      'Cámaras Cinema 4K',
      'Set completo de iluminación cinematográfica',
      'Micrófonos profesionales (Shure SM7B + Rode lavalier)',
      'Pantalla LED grande',
      'Mesa de mezclas',
      'Asistencia técnica incluida'
    ]
  }
];

export default function Landing() {
  const [estudioAbierto, setEstudioAbierto] = useState<EstudioInfo | null>(null);

  return (
    <div style={{
      maxWidth: '1200px',
      margin: '0 auto',
      padding: '0 24px'
    }}>
      {/* ============================================================
          HERO
          ============================================================ */}
      <section style={{
        minHeight: '90vh',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        position: 'relative',
        padding: '40px 0'
      }}>
        <div style={{
          position: 'absolute',
          top: '20%',
          right: '-200px',
          width: '500px',
          height: '500px',
          background: 'radial-gradient(circle, rgba(229, 184, 41, 0.12), transparent 70%)',
          borderRadius: '50%',
          pointerEvents: 'none'
        }} />

        <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '20px' }}>
          EKKO STUDIO · CULIACÁN
        </p>

        <h1 style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: 'clamp(48px, 10vw, 96px)',
          fontWeight: 700,
          letterSpacing: '-0.05em',
          lineHeight: 0.95,
          margin: 0,
          marginBottom: '24px'
        }}>
          Tu estudio.<br />
          Tu contenido.<br />
          <span style={{ color: 'var(--ek-mustard)' }}>Sin límites.</span>
        </h1>

        <p style={{
          fontSize: 'clamp(16px, 2vw, 20px)',
          color: 'var(--ek-ink-muted)',
          maxWidth: '600px',
          lineHeight: 1.5,
          marginBottom: '40px'
        }}>
          La plataforma para creadores que quieren grabar, crear y crecer
          al siguiente nivel. Equipo profesional, espacios diseñados y
          horas ilimitadas según tu membresía.
        </p>

        <a
          href="#membresias"
          className="ek-cta"
          style={{ padding: '16px 28px', fontSize: '15px', display: 'inline-block' }}
        >
          Ver membresías →
        </a>
      </section>

      {/* ============================================================
          CÓMO FUNCIONA
          ============================================================ */}
      <section style={{ padding: '80px 0' }}>
        <p className="ek-eyebrow" style={{ marginBottom: '12px' }}>CÓMO FUNCIONA</p>
        <h2 style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: 'clamp(36px, 6vw, 56px)',
          fontWeight: 700,
          letterSpacing: '-0.04em',
          margin: 0,
          marginBottom: '48px'
        }}>
          De la idea al contenido.<br />
          <span style={{ color: 'var(--ek-mustard)' }}>En tres pasos.</span>
        </h2>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: '20px'
        }}>
          {[
            {
              n: '01',
              title: 'Reserva tu sesión',
              body: 'Elige estudio, fecha y horario desde la app. Sin llamadas, sin esperas. 24 horas de anticipación mínima.'
            },
            {
              n: '02',
              title: 'Llega y graba',
              body: 'Equipo profesional ya montado. Cámaras, micrófonos, iluminación. Tú llegas con tu contenido en la cabeza.'
            },
            {
              n: '03',
              title: 'Recibe tu material',
              body: 'Te entregamos los archivos limpios después de cada sesión. Tú decides cómo editarlo y publicarlo.'
            }
          ].map((paso) => (
            <div key={paso.n} className="ek-card">
              <p style={{
                fontFamily: 'var(--ek-font-display)',
                fontSize: '32px',
                fontWeight: 700,
                color: 'var(--ek-mustard)',
                margin: 0,
                marginBottom: '12px',
                letterSpacing: '-0.04em'
              }}>{paso.n}</p>
              <h3 style={{
                fontFamily: 'var(--ek-font-display)',
                fontSize: '20px',
                fontWeight: 600,
                margin: 0,
                marginBottom: '8px'
              }}>{paso.title}</h3>
              <p style={{
                fontSize: '14px',
                color: 'var(--ek-ink-muted)',
                lineHeight: 1.5,
                margin: 0
              }}>{paso.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ============================================================
          ESTUDIOS
          ============================================================ */}
      <section style={{ padding: '80px 0' }}>
        <p className="ek-eyebrow" style={{ marginBottom: '12px' }}>NUESTROS ESPACIOS</p>
        <h2 style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: 'clamp(36px, 6vw, 56px)',
          fontWeight: 700,
          letterSpacing: '-0.04em',
          margin: 0,
          marginBottom: '16px'
        }}>
          Tres estudios.<br />
          <span style={{ color: 'var(--ek-mustard)' }}>Tres personalidades.</span>
        </h2>
        <p className="ek-body-muted" style={{ marginBottom: '40px', maxWidth: '600px' }}>
          Cada uno diseñado para un tipo de contenido. Elige el que va con tu visión.
        </p>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: '20px'
        }}>
          {ESTUDIOS.map((s) => (
            <button
              key={s.slug}
              onClick={() => setEstudioAbierto(s)}
              className="ek-card"
              style={{
                padding: 0,
                overflow: 'hidden',
                cursor: 'pointer',
                textAlign: 'left',
                border: '0.5px solid var(--ek-line)',
                background: 'var(--ek-bg-soft)',
                color: 'var(--ek-ink)',
                transition: 'transform 0.2s ease, border-color 0.2s ease',
                font: 'inherit'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = 'translateY(-2px)';
                e.currentTarget.style.borderColor = 'var(--ek-mustard-dim)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.borderColor = 'var(--ek-line)';
              }}
            >
              <div style={{
                background: 'linear-gradient(135deg, var(--ek-bg-elevated) 0%, var(--ek-bg) 100%)',
                aspectRatio: '16 / 10',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                position: 'relative'
              }}>
                <span
                  className={s.tier === 'pro' ? 'ek-badge ek-badge--outline' : 'ek-badge'}
                  style={{ position: 'absolute', top: '14px', left: '14px' }}
                >
                  {s.tier === 'pro' ? '★ PRO' : 'BÁSICA'}
                </span>
                <span style={{
                  fontSize: '10px',
                  color: 'var(--ek-ink-faint)',
                  letterSpacing: '0.2em',
                  fontWeight: 600
                }}>FOTO PRÓXIMAMENTE</span>
              </div>
              <div style={{ padding: '20px' }}>
                <h3 style={{
                  fontFamily: 'var(--ek-font-display)',
                  fontSize: '24px',
                  fontWeight: 700,
                  margin: 0,
                  marginBottom: '6px'
                }}>{s.nombre}</h3>
                <p style={{
                  fontSize: '13px',
                  color: 'var(--ek-ink-muted)',
                  margin: 0,
                  marginBottom: '6px'
                }}>{s.capacidad}</p>
                <p style={{
                  fontSize: '12px',
                  color: 'var(--ek-mustard)',
                  margin: 0,
                  marginBottom: '12px',
                  fontWeight: 600
                }}>{s.contenido.join(' · ')}</p>
                <p style={{
                  fontSize: '11px',
                  color: 'var(--ek-ink-faint)',
                  margin: 0,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  fontWeight: 600
                }}>
                  Ver detalle →
                </p>
              </div>
            </button>
          ))}
        </div>
      </section>

      {/* ============================================================
          MEMBRESÍAS
          ============================================================ */}
      <section id="membresias" style={{ padding: '80px 0' }}>
        <p className="ek-eyebrow" style={{ marginBottom: '12px' }}>MEMBRESÍAS</p>
        <h2 style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: 'clamp(36px, 6vw, 56px)',
          fontWeight: 700,
          letterSpacing: '-0.04em',
          margin: 0,
          marginBottom: '48px'
        }}>
          Elige tu nivel.<br />
          <span style={{ color: 'var(--ek-mustard)' }}>Crece desde el día uno.</span>
        </h2>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: '20px'
        }}>
          {/* Básica */}
          <div className="ek-card" style={{ padding: '32px' }}>
            <p className="ek-eyebrow" style={{ marginBottom: '12px' }}>BÁSICA</p>
            <p style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: '48px',
              fontWeight: 700,
              margin: 0,
              letterSpacing: '-0.03em',
              lineHeight: 1
            }}>$800<span style={{ fontSize: '16px', color: 'var(--ek-ink-muted)', fontWeight: 500 }}>/mes</span></p>
            <p className="ek-body-muted" style={{ marginTop: '8px', marginBottom: '24px' }}>
              Para empezar. Acceso a los estudios básicos.
            </p>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {[
                'Acceso a Estudio 1 y Estudio 2',
                '2 invitados por sesión',
                'Equipo profesional incluido',
                'Reservas hasta con 24h de anticipación',
                'Compromiso 6 meses'
              ].map((b) => (
                <li key={b} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '14px' }}>
                  <span style={{ color: 'var(--ek-mustard)' }}>✓</span>{b}
                </li>
              ))}
            </ul>
            <Link
              to="/signup?tier=basica"
              className="ek-cta ek-cta--secondary ek-cta--full"
              style={{ marginTop: '28px' }}
            >
              Empezar con Básica
            </Link>
          </div>

          {/* Pro */}
          <div
            className="ek-card"
            style={{
              padding: '32px',
              borderColor: 'var(--ek-mustard)',
              boxShadow: '0 0 0 1px var(--ek-mustard-dim), 0 20px 60px rgba(229, 184, 41, 0.08)'
            }}
          >
            <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '12px' }}>★ PRO · RECOMENDADA</p>
            <p style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: '48px',
              fontWeight: 700,
              margin: 0,
              letterSpacing: '-0.03em',
              lineHeight: 1
            }}>$1,200<span style={{ fontSize: '16px', color: 'var(--ek-ink-muted)', fontWeight: 500 }}>/mes</span></p>
            <p className="ek-body-muted" style={{ marginTop: '8px', marginBottom: '24px' }}>
              Para creadores serios. Acceso completo.
            </p>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {[
                'Acceso a TODOS los estudios (incluye Black)',
                '4 invitados por sesión',
                'Equipo profesional premium',
                'Reservas hasta con 24h de anticipación',
                'Prioridad en bookings de Black',
                'Compromiso 6 meses'
              ].map((b) => (
                <li key={b} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', fontSize: '14px' }}>
                  <span style={{ color: 'var(--ek-mustard)' }}>✓</span>{b}
                </li>
              ))}
            </ul>
            <Link
              to="/signup?tier=pro"
              className="ek-cta ek-cta--full"
              style={{ marginTop: '28px' }}
            >
              Quiero la Pro
            </Link>
          </div>
        </div>
      </section>

      {/* ============================================================
          FAQ
          ============================================================ */}
      <section style={{ padding: '80px 0' }}>
        <p className="ek-eyebrow" style={{ marginBottom: '12px' }}>PREGUNTAS FRECUENTES</p>
        <h2 style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: 'clamp(36px, 6vw, 56px)',
          fontWeight: 700,
          letterSpacing: '-0.04em',
          margin: 0,
          marginBottom: '48px'
        }}>
          Lo que probablemente quieres saber.
        </h2>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {[
            {
              q: '¿Qué incluye la membresía?',
              a: 'Acceso a los estudios según tu plan, todo el equipo profesional ya montado (cámaras, micrófonos, iluminación), espacio para invitados y reservas vía app.'
            },
            {
              q: '¿Puedo cancelar cuándo quiera?',
              a: 'El compromiso mínimo es de 6 meses. Después puedes cancelar con 30 días de anticipación. Sin penalidades por cancelación pasado el commitment.'
            },
            {
              q: '¿Qué pasa si no llego a mi reserva?',
              a: 'Las inasistencias bloquean tu cuenta por 1 semana automáticamente. Pero si avisas con anticipación, puedes cancelar sin penalidad.'
            },
            {
              q: '¿Necesito traer mi propio equipo?',
              a: 'No. Cada estudio tiene su equipo profesional completo. Solo traes tu contenido y tu disco duro para llevarte el material.'
            },
            {
              q: '¿Puedo invitar gente?',
              a: 'Sí. Básica permite hasta 2 invitados por sesión, Pro hasta 4. Para producciones más grandes en Black, contáctanos.'
            },
            {
              q: '¿Cómo me cobran?',
              a: 'Cobro mensual automatizado vía tarjeta. El primer mes incluye onboarding y configuración de tu cuenta.'
            }
          ].map((item) => (
            <details key={item.q} className="ek-card" style={{ padding: '20px 24px', cursor: 'pointer' }}>
              <summary style={{
                fontFamily: 'var(--ek-font-display)',
                fontSize: '17px',
                fontWeight: 600,
                letterSpacing: '-0.01em',
                listStyle: 'none',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center'
              }}>
                {item.q}
                <span style={{ color: 'var(--ek-mustard)', fontSize: '14px' }}>+</span>
              </summary>
              <p style={{
                fontSize: '14px',
                color: 'var(--ek-ink-muted)',
                lineHeight: 1.6,
                margin: 0,
                marginTop: '12px'
              }}>{item.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* ============================================================
          CTA + CONTACTO
          ============================================================ */}
      <section id="contacto" style={{ padding: '100px 0' }}>
        <div style={{
          background: 'linear-gradient(135deg, var(--ek-bg-elevated) 0%, var(--ek-bg) 100%)',
          border: '0.5px solid var(--ek-mustard-dim)',
          borderRadius: 'var(--ek-r-card)',
          padding: 'clamp(32px, 6vw, 64px)',
          textAlign: 'center',
          position: 'relative',
          overflow: 'hidden'
        }}>
          <div style={{
            position: 'absolute',
            top: '-100px',
            right: '-100px',
            width: '300px',
            height: '300px',
            background: 'radial-gradient(circle, rgba(229, 184, 41, 0.1), transparent 70%)',
            borderRadius: '50%',
            pointerEvents: 'none'
          }} />

          <p className="ek-eyebrow ek-eyebrow--mustard" style={{ marginBottom: '16px' }}>
            CULIACÁN · MÉXICO
          </p>
          <h2 style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: 'clamp(32px, 5vw, 48px)',
            fontWeight: 700,
            letterSpacing: '-0.04em',
            margin: 0,
            marginBottom: '16px',
            lineHeight: 1.1
          }}>
            ¿Listo para llevar tu contenido<br />al siguiente nivel?
          </h2>
          <p className="ek-body-muted" style={{ marginBottom: '32px', maxWidth: '500px', marginLeft: 'auto', marginRight: 'auto' }}>
            Agenda una visita sin compromiso. Te mostramos los estudios y te ayudamos a elegir tu membresía.
          </p>
          <a
            href="https://wa.me/5216670000000?text=Hola%2C%20me%20interesa%20conocer%20EKKO%20Studio"
            target="_blank"
            rel="noopener noreferrer"
            className="ek-cta"
            style={{ padding: '18px 32px', fontSize: '15px' }}
          >
            Contáctanos por WhatsApp →
          </a>
        </div>
      </section>

      {/* ============================================================
          FOOTER
          ============================================================ */}
      <footer style={{
        padding: '40px 0',
        borderTop: '0.5px solid var(--ek-line)',
        marginTop: '40px'
      }}>
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '20px'
        }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px' }}>
            <span style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: '20px',
              fontWeight: 700,
              letterSpacing: '-0.04em',
              color: 'var(--ek-mustard)'
            }}>EKKO</span>
            <span className="ek-eyebrow">STUDIO · CULIACÁN</span>
          </div>

          <div style={{ display: 'flex', gap: '20px', fontSize: '13px', color: 'var(--ek-ink-muted)' }}>
            <a href="/login" style={{ color: 'inherit', textDecoration: 'none' }}>Iniciar sesión</a>
            <a href="#contacto" style={{ color: 'inherit', textDecoration: 'none' }}>Contacto</a>
          </div>
        </div>

        <p style={{
          fontSize: '11px',
          color: 'var(--ek-ink-faint)',
          marginTop: '24px',
          letterSpacing: '0.04em'
        }}>
          © {new Date().getFullYear()} EKKO Studio. Todos los derechos reservados.
        </p>
      </footer>

      <EstudioModal
        estudio={estudioAbierto}
        onClose={() => setEstudioAbierto(null)}
      />
    </div>
  );
}
