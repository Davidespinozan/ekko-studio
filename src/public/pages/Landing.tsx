import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Star, ArrowRight, Check, X, CalendarCheck, Clapperboard, FolderDown, ImageIcon } from 'lucide-react';
import { supabase } from '@shared/lib/supabase';
import { ErrorInline } from '@shared/components/ErrorCarga';
import { parseBeneficios } from '@shared/lib/beneficios';
import { sufijoPrecioSesiones, esTierRecomendado, esPlanPaquete } from '@shared/lib/planPresentacion';
import { useLandingConfig } from '@shared/hooks/useLandingConfig';
import EstudioModal, { type EstudioInfo } from '../components/EstudioModal';
import AppShowcase from '../components/AppShowcase';
import { Reveal } from '../components/Reveal';
import { MagneticButton } from '@shared/components/MagneticButton';
import { PlanTipoToggle } from '@shared/components/PlanTipoToggle';
import Footer from '../components/Footer';
import { LandingNav } from '../components/LandingNav';
import { partirPalabras, sinFlecha, instalarBrilloTarjetas, instalarProgresoScroll, instalarSpotlight } from '../lib/landingFx';
import '../../styles/landing.css';

// Íconos de "Cómo funciona" por posición (el texto es editable; el ícono no).
const PASO_ICONS = [CalendarCheck, Clapperboard, FolderDown];

interface EstudioPublico {
  id: string;
  slug: string;
  nombre: string;
  descripcion: string | null;
  tiers_permitidos: string[];
  costo_creditos: number;
  tipo_contenido: string[] | null;
  equipo_incluido: string[] | null;
  estilo_visual: string | null;
  capacidad_personas: number | null;
  foto_url: string | null;
}

interface TierPublico {
  slug: string;
  nombre: string;
  precio_centavos: number;
  descripcion: string | null;
  beneficios: unknown;
  reglas: Record<string, unknown> | null;
  tipo: string;
  clases_incluidas: number | null;
  orden: number;
}

function useEstudiosPublicos() {
  const [estudios, setEstudios] = useState<EstudioPublico[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // PKG-02A (C02 · F20): un fallo público no es una landing "sin estudios".
  const [error, setError] = useState(false);
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    let mounted = true;
    async function load() {
      setError(false);
      const { data, error: qErr } = await supabase
        .from('recursos')
        .select(
          'id, slug, nombre, descripcion, tiers_permitidos, costo_creditos, tipo_contenido, equipo_incluido, estilo_visual, capacidad_personas, foto_url'
        )
        .eq('activo', true)
        .order('orden', { ascending: true });

      if (!mounted) return;
      if (qErr) {
        console.error('[useEstudiosPublicos]', qErr);
        setError(true);
      } else {
        setEstudios((data ?? []) as EstudioPublico[]);
      }
      setIsLoading(false);
    }
    load();
    return () => { mounted = false; };
  }, [intento]);

  return { estudios, isLoading, error, recargar: () => setIntento((n) => n + 1) };
}

function useTiersPublicos() {
  const [tiers, setTiers] = useState<TierPublico[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // PKG-02A (C02 · F20): un fallo público no es una landing "sin tiers".
  const [error, setError] = useState(false);
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    let mounted = true;
    async function load() {
      setError(false);
      const { data, error: qErr } = await supabase
        .from('tiers')
        .select('slug, nombre, precio_centavos, descripcion, beneficios, reglas, tipo, clases_incluidas, orden')
        .eq('activo', true)
        .eq('en_venta', true)
        .order('orden', { ascending: true });

      if (!mounted) return;
      if (qErr) {
        console.error('[useTiersPublicos]', qErr);
        setError(true);
      } else {
        setTiers((data ?? []) as TierPublico[]);
      }
      setIsLoading(false);
    }
    load();
    return () => { mounted = false; };
  }, [intento]);

  return { tiers, isLoading, error, recargar: () => setIntento((n) => n + 1) };
}

function formatearPesos(centavos: number): string {
  return `$${Math.round(centavos / 100).toLocaleString('es-MX')}`;
}

export default function Landing() {
  const [estudioAbierto, setEstudioAbierto] = useState<EstudioInfo | null>(null);
  const [tipoPlanVista, setTipoPlanVista] = useState<'membresias' | 'paquetes'>('membresias');
  const estudiosRef = useRef<HTMLDivElement>(null);
  const scrollEstudios = (dir: number) => {
    const el = estudiosRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.min(el.clientWidth * 0.8, 480), behavior: 'smooth' });
  };
  const { estudios, isLoading: estudiosLoading, error: estudiosError, recargar: recargarEstudios } = useEstudiosPublicos();
  const { tiers, isLoading: tiersLoading, error: tiersError, recargar: recargarTiers } = useTiersPublicos();
  const { hero, cta_final, whatsappUrl, membresias, estudios: estudiosCopy, como_funciona, faq, estudio_modal } =
    useLandingConfig();
  const ctaWhatsappUrl = whatsappUrl();
  const raizRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLElement>(null);
  // Capa premium (Fase 1): brillo que sigue al cursor en las tarjetas, barra de
  // progreso de lectura y foco del hero. Cada instalador devuelve su limpieza.
  useEffect(() => {
    const quitar = [instalarBrilloTarjetas(raizRef.current), instalarProgresoScroll(), instalarSpotlight(heroRef.current)];
    return () => quitar.forEach((q) => q());
  }, []);
  // Cinta: los tipos de contenido reales de los estudios más lo que pasa en EKKO
  // (decorativa; se repite dos veces para el bucle). No repite nombres de estudios.
  const cinta = Array.from(new Set([
    ...estudios.flatMap((e) => e.tipo_contenido ?? []).map((t) => t.trim()).filter(Boolean),
    'Equipo profesional ya montado', 'Material entregado en MP4', 'Reserva desde la app', 'Culiacán'
  ]));

  const aEstudioInfo = (r: EstudioPublico): EstudioInfo => {
    return {
      slug: r.slug,
      nombre: r.nombre,
      capacidad: r.capacidad_personas
        ? `Hasta ${r.capacidad_personas} personas`
        : 'Capacidad por confirmar',
      contenido: r.tipo_contenido ?? [],
      descripcion: r.descripcion ?? '',
      estiloVisual: r.estilo_visual ?? '',
      equipoIncluido: r.equipo_incluido ?? [],
      fotoUrl: r.foto_url ?? undefined,
      esPro: (r.costo_creditos ?? 1) >= 2
    };
  };

  const estudiosInfo = estudios.map(aEstudioInfo);

  // Los dos modelos conviven: membresías mensuales (acceso) y paquetes de
  // créditos (uso puntual). Se separan por pestaña para no saturar el landing.
  const planesMensuales = tiers.filter((t) => !esPlanPaquete(t));
  const planesPaquetes = tiers.filter((t) => esPlanPaquete(t));
  const hayAmbosTipos = planesMensuales.length > 0 && planesPaquetes.length > 0;
  const vistaPlan =
    tipoPlanVista === 'paquetes' && planesPaquetes.length > 0
      ? 'paquetes'
      : planesMensuales.length > 0
        ? 'membresias'
        : 'paquetes';
  const planesVisibles = vistaPlan === 'membresias' ? planesMensuales : planesPaquetes;

  return (
    <div ref={raizRef} className="ek-landing" style={{
      maxWidth: '1200px',
      margin: '0 auto',
      padding: '0 24px'
    }}>
      <LandingNav />
      <div className="ek-progreso" aria-hidden="true" />
      <div className="ek-grain" aria-hidden="true" />
      <div className="ek-aurora" aria-hidden="true"><i /><i /><i /></div>

      {/* ============================================================
          HERO
          ============================================================ */}
      <section id="inicio" ref={heroRef} className="ek-hero" style={{
        minHeight: '86vh',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative'
      }}>
        <div style={{
          position: 'absolute',
          top: '20%',
          // Clamp del offset: en pantallas chicas (iPhone SE) -200px tiraba
          // casi todo el glow fuera de canvas; el clamp lo acerca (MA4).
          right: 'clamp(-200px, -25vw, -80px)',
          width: '500px',
          height: '500px',
          background: 'radial-gradient(circle, rgba(229, 184, 41, 0.12), transparent 70%)',
          borderRadius: '50%',
          pointerEvents: 'none'
        }} />

        {/* Orbs animados de fondo — dan "vida" al hero (respetan reduced-motion) */}
        <div className="ek-orb" aria-hidden="true" style={{ width: 320, height: 320, top: '-40px', right: 'clamp(-120px, -8vw, 20px)', opacity: 0.28 }} />
        <div className="ek-orb" aria-hidden="true" style={{ width: 260, height: 260, bottom: '-60px', left: '-80px', opacity: 0.2, animationDelay: '-8s', animationDuration: '26s' }} />
        <div className="ek-hero-spot" aria-hidden="true" />

        {hero.eyebrow && (
          <span className="ek-pill"><span className="ek-pill-dot" aria-hidden="true" />{hero.eyebrow}</span>
        )}

        <h1 style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: 'clamp(48px, 10vw, 96px)',
          fontWeight: 700,
          letterSpacing: '-0.05em',
          lineHeight: 0.95,
          margin: 0,
          marginBottom: '16px'
        }}>
          {partirPalabras(hero.titulo).map((palabra, i) => (
            <span key={`${palabra}-${i}`}>
              <span className="ek-palabra" style={{ animationDelay: `${0.08 * i}s` }}>{palabra}</span>{' '}
            </span>
          ))}
          {hero.titulo_accent && (
            <>
              {hero.titulo && <br />}
              <span className="ek-palabra ek-grad" style={{ animationDelay: `${0.08 * partirPalabras(hero.titulo).length + 0.1}s` }}>{hero.titulo_accent}</span>
            </>
          )}
        </h1>

        {hero.subtitulo && (
          <p style={{
            fontSize: 'clamp(16px, 2vw, 20px)',
            color: 'var(--ek-ink-muted)',
            maxWidth: '600px',
            lineHeight: 1.5,
            marginBottom: '28px'
          }}>
            {hero.subtitulo}
          </p>
        )}

        <div className="ek-hero-ctas">
          <MagneticButton
            href={hero.cta_link || '#membresias'}
            className="ek-cta ek-cta--gold ek-hero-cta"
            style={{
              padding: '15px 30px',
              fontSize: '15px',
              minHeight: '52px',
              width: 'auto',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px'
            }}
          >
            {sinFlecha(hero.cta_texto)} <ArrowRight size={18} aria-hidden="true" />
          </MagneticButton>
          <a href="#estudios" className="ek-cta ek-cta--ghost" style={{ padding: '15px 24px', fontSize: '15px', minHeight: '52px' }}>
            Conoce los estudios
          </a>
        </div>
        <div className="ek-hero-ticks" aria-label="Lo que incluye">
          <span><Check size={16} aria-hidden="true" />Equipo profesional ya montado</span>
          <span><Check size={16} aria-hidden="true" />Reserva desde la app</span>
          <span><Check size={16} aria-hidden="true" />Material entregado en MP4</span>
        </div>
        <div className="ek-scroll-hint" aria-hidden="true" />
      </section>

      {/* Cinta: lo que pasa en EKKO, en marquesina (decorativa). */}
      <div className="ek-cinta" aria-hidden="true">
        <div className="ek-cinta-track">
          {[...cinta, ...cinta].map((t, i) => <span key={`${t}-${i}`}>{t}</span>)}
        </div>
      </div>

      {/* ============================================================
          TU ESTUDIO EN EL BOLSILLO (sección 2 — showcase de la app)
          ============================================================ */}
      <Reveal><AppShowcase /></Reveal>

      {/* ============================================================
          CÓMO FUNCIONA
          ============================================================ */}
      <Reveal>
      <section id="como-funciona" style={{ padding: 'clamp(40px, 7vw, 64px) 0' }}>
        {como_funciona.eyebrow && (
          <p className="ek-kicker" style={{ marginBottom: '12px' }}>{como_funciona.eyebrow}</p>
        )}
        <h2 style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: 'clamp(36px, 6vw, 56px)',
          fontWeight: 700,
          letterSpacing: '-0.04em',
          lineHeight: 1.08,
          margin: 0,
          marginBottom: '28px'
        }}>
          {como_funciona.titulo}
          {como_funciona.titulo_accent && (
            <>
              <br />
              <span className="ek-grad">{como_funciona.titulo_accent}</span>
            </>
          )}
        </h2>

        <div className="ek-step-grid">
          {como_funciona.pasos.map((paso, i) => {
            const Icon = PASO_ICONS[i % PASO_ICONS.length];
            const n = String(i + 1).padStart(2, '0');
            return (
            <div
              key={n}
              className="ek-card ek-card--md ek-step-card ek-glow"
            >
              <span className="ek-empty-icon ek-step-icon" style={{ width: 44, height: 44 }}>
                <Icon size={20} aria-hidden="true" />
              </span>
              <div className="ek-step-text">
                <p className="ek-kicker" style={{ marginBottom: '6px' }}>
                  PASO {n}
                </p>
                <h3 className="ek-step-title" style={{
                  fontFamily: 'var(--ek-font-display)',
                  fontSize: '18px',
                  fontWeight: 600,
                  margin: 0,
                  marginBottom: '6px',
                  letterSpacing: '-0.02em'
                }}>{paso.titulo}</h3>
                <p className="ek-step-body" style={{
                  fontSize: '13.5px',
                  color: 'var(--ek-ink-muted)',
                  lineHeight: 1.5,
                  margin: 0
                }}>{paso.texto}</p>
              </div>
            </div>
            );
          })}
        </div>
      </section>
      </Reveal>

      {/* ============================================================
          ESTUDIOS
          ============================================================ */}
      <Reveal>
      <section id="estudios" style={{ padding: 'clamp(40px, 7vw, 64px) 0' }}>
        {estudiosCopy.eyebrow && (
          <p className="ek-kicker" style={{ marginBottom: '12px' }}>{estudiosCopy.eyebrow}</p>
        )}
        <h2 style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: 'clamp(36px, 6vw, 56px)',
          fontWeight: 700,
          letterSpacing: '-0.04em',
          lineHeight: 1.08,
          margin: 0,
          marginBottom: '16px'
        }}>
          {estudiosCopy.titulo}
          {estudiosCopy.titulo_accent && (
            <>
              <br />
              <span className="ek-grad">{estudiosCopy.titulo_accent}</span>
            </>
          )}
        </h2>
        {estudiosCopy.subtitulo && (
          <p className="ek-body-muted" style={{ marginBottom: '40px', maxWidth: '600px' }}>
            {estudiosCopy.subtitulo}
          </p>
        )}

        {estudiosError ? (
          // PKG-02A (F20): aviso discreto, sin tecnicismos; el resto de la landing sigue.
          <ErrorInline mensaje="No pudimos cargar los estudios en este momento." onReintentar={recargarEstudios} />
        ) : estudiosLoading ? (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: '20px'
          }}>
            {[1, 2, 3].map((n) => (
              <div key={n} className="ek-skeleton" style={{ height: '380px', borderRadius: 'var(--ek-r-landing)' }} />
            ))}
          </div>
        ) : (
          <div className="ek-estudio-scroller">
          <div className="ek-estudio-grid" ref={estudiosRef}>
            {estudiosInfo.map((s) => (
              <button
                key={s.slug}
                onClick={() => setEstudioAbierto(s)}
                className="ek-estudio-card ek-glow"
              >
                <div className="ek-estudio-media">
                  {s.esPro && (
                    <span style={{
                      position: 'absolute',
                      top: '12px',
                      left: '12px',
                      zIndex: 2,
                      padding: '4px 10px',
                      borderRadius: '999px',
                      background: 'var(--ek-mustard)',
                      color: 'var(--ek-bg)',
                      fontSize: '10px',
                      fontWeight: 700,
                      letterSpacing: '0.08em'
                    }}>PRO</span>
                  )}
                  {s.fotoUrl ? (
                    <img src={s.fotoUrl} alt={s.nombre} loading="lazy" decoding="async" />
                  ) : (
                    <div style={{
                      width: '100%',
                      height: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'var(--ek-ink-faint)'
                    }}>
                      <ImageIcon size={22} strokeWidth={1.5} aria-hidden="true" />
                    </div>
                  )}
                </div>
                <div className="ek-estudio-body">
                  <h3 className="ek-estudio-title" style={{
                    fontFamily: 'var(--ek-font-display)',
                    fontSize: '24px',
                    fontWeight: 700,
                    margin: 0,
                    marginBottom: '14px'
                  }}>{s.nombre}</h3>
                  <p className="ek-estudio-detalle" style={{
                    fontSize: '11px',
                    color: 'var(--ek-ink-faint)',
                    margin: 0,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    fontWeight: 700,
                    alignItems: 'center',
                    gap: '5px'
                  }}>
                    Ver detalle <ArrowRight size={13} aria-hidden="true" />
                  </p>
                </div>
              </button>
            ))}
          </div>
          {estudiosInfo.length > 1 && (
            <>
              <button type="button" className="ek-estudio-nav ek-estudio-nav--prev" onClick={() => scrollEstudios(-1)} aria-label="Ver estudio anterior">‹</button>
              <button type="button" className="ek-estudio-nav ek-estudio-nav--next" onClick={() => scrollEstudios(1)} aria-label="Ver siguiente estudio">›</button>
            </>
          )}
          </div>
        )}
      </section>
      </Reveal>

      {/* ============================================================
          MEMBRESÍAS
          ============================================================ */}
      <Reveal>
      <section id="membresias" style={{ padding: 'clamp(40px, 7vw, 64px) 0', textAlign: 'center' }}>
        {membresias.eyebrow && (
          <p className="ek-kicker" style={{ marginBottom: '12px' }}>{membresias.eyebrow}</p>
        )}
        <h2 style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: 'clamp(36px, 6vw, 56px)',
          fontWeight: 700,
          letterSpacing: '-0.04em',
          lineHeight: 1.08,
          margin: 0,
          marginBottom: '28px'
        }}>
          {membresias.titulo}
          {membresias.titulo_accent && (
            <>
              <br />
              <span className="ek-grad">{membresias.titulo_accent}</span>
            </>
          )}
        </h2>

        {/* Toggle Membresías · Paquetes — solo si existen ambos tipos. Resuelve
            el "muchísimos cuadros": nunca se ven los dos grupos a la vez. */}
        {!tiersLoading && hayAmbosTipos && (
          <PlanTipoToggle value={vistaPlan} onChange={setTipoPlanVista} />
        )}

        {tiersError ? (
          <ErrorInline mensaje="No pudimos cargar los planes en este momento." onReintentar={recargarTiers} />
        ) : tiersLoading ? (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: '20px'
          }}>
            {[1, 2].map((n) => (
              <div key={n} className="ek-skeleton" style={{ height: '480px', borderRadius: 'var(--ek-r-landing)' }} />
            ))}
          </div>
        ) : (
          <div className="ek-pricing-grid">
            {planesVisibles.map((tier) => {
              // El destacado (dorado + estrella) lo controla el admin con el flag
              // reglas.recomendado — no un slug fijo. Así se elige desde admin.
              const esRecomendado = esTierRecomendado(tier.reglas);
              const beneficios = parseBeneficios(tier.beneficios);

              return (
                <div
                  key={tier.slug}
                  className={`ek-card ek-pricing-card ${esRecomendado ? 'ek-card--gold' : 'ek-card--cream'}`}
                  style={{ display: 'flex', flexDirection: 'column' }}
                >
                  <p
                    className={esRecomendado ? 'ek-eyebrow ek-eyebrow--mustard' : 'ek-eyebrow'}
                    style={{ marginBottom: '12px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                  >
                    {esRecomendado && <Star size={12} fill="currentColor" aria-hidden="true" />}
                    {esRecomendado ? `${tier.nombre.toUpperCase()} · RECOMENDADO` : tier.nombre.toUpperCase()}
                  </p>
                  <p className="ek-pricing-price" style={{
                    fontFamily: 'var(--ek-font-display)',
                    fontWeight: 700,
                    margin: 0,
                    letterSpacing: '-0.03em',
                    lineHeight: 1
                  }}>
                    {formatearPesos(tier.precio_centavos)}
                    <span style={{ fontSize: '15px', color: 'var(--ek-ink-muted)', fontWeight: 500 }}>
                      {sufijoPrecioSesiones(tier)}
                    </span>
                  </p>
                  <p className="ek-body-muted ek-pricing-benefit" style={{ marginTop: '8px', marginBottom: '20px' }}>
                    {tier.descripcion ?? 'Sesiones para grabar cuando lo necesites.'}
                  </p>
                  <ul
                    style={{
                      listStyle: 'none',
                      padding: 0,
                      margin: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '9px',
                      flex: 1
                    }}
                  >
                    {beneficios.map((b, i) => (
                      <li
                        key={i}
                        className="ek-pricing-benefit"
                        style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: '8px',
                          fontSize: '14px',
                          color: b.incluido ? undefined : 'var(--ek-ink-faint)'
                        }}
                      >
                        {b.incluido ? (
                          <Check size={15} style={{ color: 'var(--ek-mustard)', flexShrink: 0, marginTop: '2px' }} aria-hidden="true" />
                        ) : (
                          <X size={15} style={{ color: 'var(--ek-ink-faint)', flexShrink: 0, marginTop: '2px' }} aria-hidden="true" />
                        )}
                        <span style={{ textDecoration: b.incluido ? 'none' : 'line-through' }}>{b.label}</span>
                      </li>
                    ))}
                  </ul>
                  <Link
                    to={`/signup?tier=${tier.slug}`}
                    className={
                      esRecomendado ? 'ek-cta ek-cta--full' : 'ek-cta ek-cta--secondary ek-cta--full'
                    }
                    style={{ marginTop: '24px' }}
                  >
                    {`Empezar con ${tier.nombre}`}
                  </Link>
                </div>
              );
            })}
          </div>
        )}

        {/* Letra chiquita de las membresías (términos que pidió el cliente). */}
        {!tiersLoading && vistaPlan === 'membresias' && planesMensuales.length > 0 && (
          <p className="ek-plan-fineprint">
            Membresía mes a mes, cancela cuando quieras · pago automático mensual · el tiempo adicional tiene costo extra · no se reservan horas continuas.
          </p>
        )}
      </section>
      </Reveal>

      {/* ============================================================
          FAQ
          ============================================================ */}
      <Reveal>
      <section id="faq" style={{ padding: 'clamp(40px, 7vw, 64px) 0' }}>
        {faq.eyebrow && (
          <p className="ek-kicker" style={{ marginBottom: '12px' }}>{faq.eyebrow}</p>
        )}
        <h2 style={{
          fontFamily: 'var(--ek-font-display)',
          fontSize: 'clamp(36px, 6vw, 56px)',
          fontWeight: 700,
          letterSpacing: '-0.04em',
          lineHeight: 1.08,
          margin: 0,
          marginBottom: '28px'
        }}>
          {faq.titulo}
        </h2>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {faq.items.map((item) => (
            <details key={item.q} className="ek-card ek-glow ek-faq-item" style={{ padding: '20px 24px', borderRadius: 'var(--ek-r-landing)' }}>
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
                <span className="ek-faq-plus" aria-hidden="true">+</span>
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
      </Reveal>

      {/* ============================================================
          CTA + CONTACTO
          ============================================================ */}
      <Reveal>
      <section id="contacto" style={{ padding: 'clamp(28px, 5vw, 48px) 0' }}>
        <div className="ek-cierre">
          {cta_final.eyebrow && (
            <p className="ek-kicker" style={{ marginBottom: '14px' }}>
              {cta_final.eyebrow}
            </p>
          )}
          <h2 style={{
            fontFamily: 'var(--ek-font-display)',
            fontSize: 'clamp(24px, 3.4vw, 38px)',
            fontWeight: 700,
            letterSpacing: '-0.03em',
            margin: '0 auto 12px',
            maxWidth: '18ch',
            lineHeight: 1.1
          }}>
            {cta_final.titulo}
          </h2>
          {cta_final.subtitulo && (
            <p className="ek-body-muted" style={{ marginBottom: '26px', maxWidth: '440px', marginLeft: 'auto', marginRight: 'auto' }}>
              {cta_final.subtitulo}
            </p>
          )}
          {ctaWhatsappUrl ? (
            <MagneticButton
              href={ctaWhatsappUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ek-cta ek-cta--gold"
              style={{ padding: '15px 30px', fontSize: '15px', minHeight: '52px' }}
            >
              {sinFlecha(cta_final.cta_texto)} <ArrowRight size={18} aria-hidden="true" />
            </MagneticButton>
          ) : (
            <span
              style={{
                fontSize: '12px',
                color: 'var(--ek-ink-faint)',
                fontStyle: 'italic'
              }}
              title="Configura el WhatsApp en /admin/configuracion"
            >
              (Contacto sin configurar)
            </span>
          )}
        </div>
      </section>
      </Reveal>

      {/* ============================================================
          FOOTER (extraído a src/public/components/Footer.tsx)
          ============================================================ */}
      {ctaWhatsappUrl && (
        <a className="ek-wa-float" href={ctaWhatsappUrl} target="_blank" rel="noopener noreferrer" aria-label="¿Dudas? Escríbenos por WhatsApp">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.885-9.885 9.885m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413z" /></svg>
          <span className="ek-wa-txt">¿Dudas? <b>Escríbenos</b></span>
        </a>
      )}

      <Footer />

      <EstudioModal
        estudio={estudioAbierto}
        onClose={() => setEstudioAbierto(null)}
        ctaTexto={estudio_modal.cta_texto}
        ctaLink={estudio_modal.cta_link}
      />
    </div>
  );
}
