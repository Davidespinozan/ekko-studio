import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useTenantConfigEditor } from '../hooks/useTenantConfigEditor';
import { useToast } from '@shared/hooks/useToast';
import {
  MEMBRESIAS_DEFAULT,
  ESTUDIOS_DEFAULT,
  COMO_FUNCIONA_DEFAULT,
  FAQ_DEFAULT,
  ESTUDIO_MODAL_DEFAULT,
  parseMembresias,
  parseEstudios,
  parseComoFunciona,
  parseFaq,
  parseEstudioModal,
  type MembresiasConfig,
  type EstudiosConfig,
  type ComoFuncionaConfig,
  type FaqConfig,
  type EstudioModalConfig
} from '@shared/lib/landingDefaults';
import { ConfigLoadErrorBanner } from '../components/ConfigLoadErrorBanner';

type HeroDraft = {
  eyebrow: string;
  titulo: string;
  titulo_accent: string;
  subtitulo: string;
  cta_texto: string;
  cta_link: string;
};

type CtaFinalDraft = {
  eyebrow: string;
  titulo: string;
  subtitulo: string;
  cta_texto: string;
};

type FooterDraft = {
  tagline: string;
  copyright: string;
  direccion: string;
  email: string;
};

type LandingDraft = {
  hero: HeroDraft;
  cta_final: CtaFinalDraft;
  footer: FooterDraft;
  membresias: MembresiasConfig;
  estudios: EstudiosConfig;
  como_funciona: ComoFuncionaConfig;
  faq: FaqConfig;
  estudio_modal: EstudioModalConfig;
};

const EMPTY: LandingDraft = {
  hero: { eyebrow: '', titulo: '', titulo_accent: '', subtitulo: '', cta_texto: '', cta_link: '' },
  cta_final: { eyebrow: '', titulo: '', subtitulo: '', cta_texto: '' },
  footer: { tagline: '', copyright: '', direccion: '', email: '' },
  membresias: MEMBRESIAS_DEFAULT,
  estudios: ESTUDIOS_DEFAULT,
  como_funciona: COMO_FUNCIONA_DEFAULT,
  faq: FAQ_DEFAULT,
  estudio_modal: ESTUDIO_MODAL_DEFAULT
};

function readLanding(config: Record<string, unknown> | null): LandingDraft {
  const landing = (config?.landing ?? {}) as Record<string, unknown>;
  const hero = (landing.hero ?? {}) as Record<string, unknown>;
  const ctaFinal = (landing.cta_final ?? {}) as Record<string, unknown>;
  const footer = (landing.footer ?? {}) as Record<string, unknown>;
  return {
    hero: {
      eyebrow: String(hero.eyebrow ?? ''),
      titulo: String(hero.titulo ?? ''),
      titulo_accent: String(hero.titulo_accent ?? ''),
      subtitulo: String(hero.subtitulo ?? ''),
      cta_texto: String(hero.cta_texto ?? ''),
      cta_link: String(hero.cta_link ?? '')
    },
    cta_final: {
      eyebrow: String(ctaFinal.eyebrow ?? ''),
      titulo: String(ctaFinal.titulo ?? ''),
      subtitulo: String(ctaFinal.subtitulo ?? ''),
      cta_texto: String(ctaFinal.cta_texto ?? '')
    },
    footer: {
      tagline: String(footer.tagline ?? ''),
      copyright: String(footer.copyright ?? ''),
      direccion: footer.direccion == null ? '' : String(footer.direccion),
      email: footer.email == null ? '' : String(footer.email)
    },
    // Estas caen a su copy default (landingDefaults) si el tenant nunca las tocó,
    // así el editor muestra el contenido real que ve el visitante, no campos vacíos.
    membresias: parseMembresias(landing.membresias),
    estudios: parseEstudios(landing.estudios),
    como_funciona: parseComoFunciona(landing.como_funciona),
    faq: parseFaq(landing.faq),
    estudio_modal: parseEstudioModal(landing.estudio_modal)
  };
}

function PageHeader({
  title,
  subtitle,
  dirty
}: {
  title: string;
  subtitle: string;
  dirty: boolean;
}) {
  return (
    <div style={{ marginBottom: '24px' }}>
      <p className="ek-eyebrow ek-eyebrow--mustard ek-eyebrow--bar">AJUSTES</p>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: '16px',
          flexWrap: 'wrap',
          marginTop: '4px'
        }}
      >
        <div>
          <h1
            style={{
              fontFamily: 'var(--ek-font-display)',
              fontSize: 'clamp(28px, 5vw, 40px)',
              fontWeight: 700,
              letterSpacing: '-0.04em',
              margin: 0,
              marginBottom: '6px'
            }}
          >
            {title}
          </h1>
          <p style={{ fontSize: '14px', color: 'var(--ek-ink-muted)', margin: 0 }}>{subtitle}</p>
        </div>
        <span
          style={{
            fontSize: '11px',
            color: dirty ? 'var(--ek-mustard)' : 'var(--ek-ink-faint)',
            fontWeight: 600,
            letterSpacing: '0.08em'
          }}
        >
          {dirty ? 'CAMBIOS SIN GUARDAR' : 'SIN CAMBIOS'}
        </span>
      </div>
    </div>
  );
}

function FormField({
  label,
  helper,
  children
}: {
  label: string;
  helper?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="ek-form-field" style={{ marginBottom: '14px' }}>
      <label className="ek-label">{label}</label>
      {children}
      {helper && (
        <p style={{ fontSize: '11px', color: 'var(--ek-ink-faint)', marginTop: '6px' }}>{helper}</p>
      )}
    </div>
  );
}

function Section({
  title,
  description,
  children
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className="ek-card"
      style={{ padding: '24px', marginBottom: '20px', display: 'block' }}
    >
      <p
        className="ek-eyebrow ek-eyebrow--mustard"
        style={{ marginBottom: '6px', fontSize: '11px' }}
      >
        {title}
      </p>
      <p style={{ fontSize: '13px', color: 'var(--ek-ink-muted)', margin: 0, marginBottom: '18px' }}>
        {description}
      </p>
      {children}
    </section>
  );
}

export default function AjustesLanding() {
  const { config, isLoading, isSaving, loadError, reload, saveTopLevel } = useTenantConfigEditor();
  const toast = useToast();
  const [draft, setDraft] = useState<LandingDraft>(EMPTY);
  const [original, setOriginal] = useState<LandingDraft>(EMPTY);

  useEffect(() => {
    if (!config) return;
    const parsed = readLanding(config);
    setDraft(parsed);
    setOriginal(parsed);
  }, [config]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(original);

  async function handleSave() {
    // OJO: saveTopLevel REEMPLAZA todo el objeto landing, así que hay que incluir
    // TODAS las secciones o se borrarían las que no van en el payload.
    const payload = {
      hero: { ...draft.hero },
      cta_final: { ...draft.cta_final },
      footer: {
        ...(((config?.landing as { footer?: Record<string, unknown> })?.footer) ?? {}),
        tagline: draft.footer.tagline,
        copyright: draft.footer.copyright,
        direccion: draft.footer.direccion || null,
        email: draft.footer.email || null
      },
      membresias: { ...draft.membresias },
      estudios: { ...draft.estudios },
      como_funciona: { ...draft.como_funciona, pasos: draft.como_funciona.pasos },
      faq: { ...draft.faq, items: draft.faq.items },
      estudio_modal: { ...draft.estudio_modal }
    };
    const { error } = await saveTopLevel({ landing: payload });
    if (error) {
      toast.error(`No se pudo guardar: ${error}`);
      return;
    }
    setOriginal(draft);
    toast.success('Cambios guardados.');
  }

  function handleDiscard() {
    setDraft(original);
  }

  // ── Listas dinámicas: pasos de "Cómo funciona" y preguntas del FAQ ──────────
  function updatePaso(i: number, patch: Partial<{ titulo: string; texto: string }>) {
    setDraft((d) => ({
      ...d,
      como_funciona: {
        ...d.como_funciona,
        pasos: d.como_funciona.pasos.map((p, idx) => (idx === i ? { ...p, ...patch } : p))
      }
    }));
  }
  function addPaso() {
    setDraft((d) => ({
      ...d,
      como_funciona: { ...d.como_funciona, pasos: [...d.como_funciona.pasos, { titulo: '', texto: '' }] }
    }));
  }
  function removePaso(i: number) {
    setDraft((d) => ({
      ...d,
      como_funciona: { ...d.como_funciona, pasos: d.como_funciona.pasos.filter((_, idx) => idx !== i) }
    }));
  }
  function updateFaq(i: number, patch: Partial<{ q: string; a: string }>) {
    setDraft((d) => ({
      ...d,
      faq: { ...d.faq, items: d.faq.items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)) }
    }));
  }
  function addFaq() {
    setDraft((d) => ({ ...d, faq: { ...d.faq, items: [...d.faq.items, { q: '', a: '' }] } }));
  }
  function removeFaq(i: number) {
    setDraft((d) => ({ ...d, faq: { ...d.faq, items: d.faq.items.filter((_, idx) => idx !== i) } }));
  }

  if (isLoading) {
    return (
      <div className="adm-page">
        <div className="ek-skeleton" style={{ height: '60px', marginBottom: '20px' }} />
        <div className="ek-skeleton" style={{ height: '400px' }} />
      </div>
    );
  }

  return (
    <div className="adm-page">
      {loadError && <ConfigLoadErrorBanner que="el contenido actual de la landing" onRetry={reload} />}
      <PageHeader
        title="Landing"
        subtitle="Edita el contenido que ven los visitantes en tu página pública."
        dirty={dirty}
      />

      <Section title="HERO" description="La primera impresión cuando alguien visita tu landing.">
        <FormField
          label="Etiqueta superior"
          helper="Texto pequeño que aparece arriba del título principal."
        >
          <input
            value={draft.hero.eyebrow}
            onChange={(e) => setDraft({ ...draft, hero: { ...draft.hero, eyebrow: e.target.value } })}
            className="ek-input"
            placeholder="EKKO STUDIO · CULIACÁN"
          />
        </FormField>

        <FormField label="Título principal">
          <input
            value={draft.hero.titulo}
            onChange={(e) => setDraft({ ...draft, hero: { ...draft.hero, titulo: e.target.value } })}
            className="ek-input"
            placeholder="Tu estudio. Tu contenido."
          />
        </FormField>

        <FormField
          label="Palabra destacada (mostaza)"
          helper="Aparece al final del título en color mostaza. Deja vacío si no quieres highlight."
        >
          <input
            value={draft.hero.titulo_accent}
            onChange={(e) =>
              setDraft({ ...draft, hero: { ...draft.hero, titulo_accent: e.target.value } })
            }
            className="ek-input"
            placeholder="Sin límites."
          />
        </FormField>

        <FormField label="Subtítulo" helper="Descripción corta del producto.">
          <textarea
            value={draft.hero.subtitulo}
            onChange={(e) =>
              setDraft({ ...draft, hero: { ...draft.hero, subtitulo: e.target.value } })
            }
            className="ek-input"
            rows={3}
          />
        </FormField>

        <FormField label="Texto del botón principal">
          <input
            value={draft.hero.cta_texto}
            onChange={(e) =>
              setDraft({ ...draft, hero: { ...draft.hero, cta_texto: e.target.value } })
            }
            className="ek-input"
            placeholder="Ver membresías →"
          />
        </FormField>

        <FormField
          label="A dónde lleva el botón"
          helper="Puede ser anchor (#nombre) o URL completa (https://...)."
        >
          <input
            value={draft.hero.cta_link}
            onChange={(e) =>
              setDraft({ ...draft, hero: { ...draft.hero, cta_link: e.target.value } })
            }
            className="ek-input"
            placeholder="#membresias"
          />
        </FormField>
      </Section>

      <Section title="CALL TO ACTION FINAL" description="El último empujón antes del footer.">
        <FormField label="Etiqueta superior">
          <input
            value={draft.cta_final.eyebrow}
            onChange={(e) =>
              setDraft({ ...draft, cta_final: { ...draft.cta_final, eyebrow: e.target.value } })
            }
            className="ek-input"
            placeholder="CULIACÁN · MÉXICO"
          />
        </FormField>

        <FormField label="Título">
          <input
            value={draft.cta_final.titulo}
            onChange={(e) =>
              setDraft({ ...draft, cta_final: { ...draft.cta_final, titulo: e.target.value } })
            }
            className="ek-input"
          />
        </FormField>

        <FormField label="Subtítulo">
          <textarea
            value={draft.cta_final.subtitulo}
            onChange={(e) =>
              setDraft({ ...draft, cta_final: { ...draft.cta_final, subtitulo: e.target.value } })
            }
            className="ek-input"
            rows={2}
          />
        </FormField>

        <FormField
          label="Texto del botón"
          helper={'El número de WhatsApp se configura en "Contacto".'}
        >
          <input
            value={draft.cta_final.cta_texto}
            onChange={(e) =>
              setDraft({ ...draft, cta_final: { ...draft.cta_final, cta_texto: e.target.value } })
            }
            className="ek-input"
            placeholder="Contáctanos por WhatsApp →"
          />
        </FormField>
      </Section>

      <Section title="FOOTER" description="El pie de página de tu landing.">
        <FormField label="Tagline (debajo del logo)">
          <input
            value={draft.footer.tagline}
            onChange={(e) =>
              setDraft({ ...draft, footer: { ...draft.footer, tagline: e.target.value } })
            }
            className="ek-input"
            placeholder="STUDIO · CULIACÁN"
          />
        </FormField>

        <FormField label="Copyright" helper="El año se agrega automáticamente.">
          <input
            value={draft.footer.copyright}
            onChange={(e) =>
              setDraft({ ...draft, footer: { ...draft.footer, copyright: e.target.value } })
            }
            className="ek-input"
            placeholder="Todos los derechos reservados."
          />
        </FormField>

        <FormField label="Dirección" helper="Opcional. Si la dejás vacía, no aparece en el footer.">
          <input
            value={draft.footer.direccion}
            onChange={(e) =>
              setDraft({ ...draft, footer: { ...draft.footer, direccion: e.target.value } })
            }
            className="ek-input"
            placeholder="Av. ... (opcional)"
          />
        </FormField>

        <FormField label="Email" helper="Opcional. Si la dejás vacía, no aparece en el footer.">
          <input
            type="email"
            value={draft.footer.email}
            onChange={(e) =>
              setDraft({ ...draft, footer: { ...draft.footer, email: e.target.value } })
            }
            className="ek-input"
            placeholder="contacto@ekkostudio.com"
          />
        </FormField>
      </Section>

      <Section
        title="ENCABEZADO DE PLANES"
        description="El título de la sección de planes. Las tarjetas de precio salen de Admin → Planes."
      >
        <FormField label="Etiqueta superior">
          <input
            value={draft.membresias.eyebrow}
            onChange={(e) => setDraft({ ...draft, membresias: { ...draft.membresias, eyebrow: e.target.value } })}
            className="ek-input"
            placeholder="PLANES"
          />
        </FormField>
        <FormField label="Título">
          <input
            value={draft.membresias.titulo}
            onChange={(e) => setDraft({ ...draft, membresias: { ...draft.membresias, titulo: e.target.value } })}
            className="ek-input"
            placeholder="Elige tu paquete."
          />
        </FormField>
        <FormField label="Palabra destacada (mostaza)" helper="Segunda línea del título, en mostaza. Vacío = sin segunda línea.">
          <input
            value={draft.membresias.titulo_accent}
            onChange={(e) => setDraft({ ...draft, membresias: { ...draft.membresias, titulo_accent: e.target.value } })}
            className="ek-input"
            placeholder="Graba cuando quieras."
          />
        </FormField>
      </Section>

      <Section
        title="ENCABEZADO DE ESTUDIOS"
        description="El título de la sección de estudios. Las tarjetas salen de Admin → Estudios."
      >
        <FormField label="Etiqueta superior">
          <input
            value={draft.estudios.eyebrow}
            onChange={(e) => setDraft({ ...draft, estudios: { ...draft.estudios, eyebrow: e.target.value } })}
            className="ek-input"
            placeholder="NUESTROS ESPACIOS"
          />
        </FormField>
        <FormField label="Título">
          <input
            value={draft.estudios.titulo}
            onChange={(e) => setDraft({ ...draft, estudios: { ...draft.estudios, titulo: e.target.value } })}
            className="ek-input"
            placeholder="Nuestros estudios."
          />
        </FormField>
        <FormField label="Palabra destacada (mostaza)" helper="Segunda línea del título, en mostaza. Vacío = sin segunda línea.">
          <input
            value={draft.estudios.titulo_accent}
            onChange={(e) => setDraft({ ...draft, estudios: { ...draft.estudios, titulo_accent: e.target.value } })}
            className="ek-input"
            placeholder="Una personalidad para cada visión."
          />
        </FormField>
        <FormField label="Subtítulo">
          <textarea
            value={draft.estudios.subtitulo}
            onChange={(e) => setDraft({ ...draft, estudios: { ...draft.estudios, subtitulo: e.target.value } })}
            className="ek-input"
            rows={2}
          />
        </FormField>
      </Section>

      <Section title="CÓMO FUNCIONA" description="Los pasos que explican tu servicio. Los íconos son fijos por posición.">
        <FormField label="Etiqueta superior">
          <input
            value={draft.como_funciona.eyebrow}
            onChange={(e) => setDraft({ ...draft, como_funciona: { ...draft.como_funciona, eyebrow: e.target.value } })}
            className="ek-input"
            placeholder="CÓMO FUNCIONA"
          />
        </FormField>
        <FormField label="Título">
          <input
            value={draft.como_funciona.titulo}
            onChange={(e) => setDraft({ ...draft, como_funciona: { ...draft.como_funciona, titulo: e.target.value } })}
            className="ek-input"
            placeholder="De la idea al contenido."
          />
        </FormField>
        <FormField label="Palabra destacada (mostaza)" helper="Segunda línea del título, en mostaza. Vacío = sin segunda línea.">
          <input
            value={draft.como_funciona.titulo_accent}
            onChange={(e) => setDraft({ ...draft, como_funciona: { ...draft.como_funciona, titulo_accent: e.target.value } })}
            className="ek-input"
            placeholder="En tres pasos."
          />
        </FormField>

        {draft.como_funciona.pasos.map((paso, i) => (
          <div
            key={i}
            style={{ padding: '14px', marginBottom: '10px', background: 'var(--ek-bg-soft)', borderRadius: 'var(--ek-r-md)', border: '0.5px solid var(--ek-line)' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
              <span className="ek-eyebrow ek-eyebrow--mustard" style={{ fontSize: '11px' }}>PASO {String(i + 1).padStart(2, '0')}</span>
              <button
                type="button"
                onClick={() => removePaso(i)}
                aria-label={`Eliminar paso ${i + 1}`}
                style={{ background: 'none', border: 'none', color: 'var(--ek-ink-faint)', cursor: 'pointer', padding: '4px' }}
              >
                <Trash2 size={15} />
              </button>
            </div>
            <input
              value={paso.titulo}
              onChange={(e) => updatePaso(i, { titulo: e.target.value })}
              className="ek-input"
              placeholder="Título del paso"
              style={{ marginBottom: '8px' }}
            />
            <textarea
              value={paso.texto}
              onChange={(e) => updatePaso(i, { texto: e.target.value })}
              className="ek-input"
              rows={2}
              placeholder="Descripción del paso"
            />
          </div>
        ))}
        <button
          type="button"
          onClick={addPaso}
          className="ek-cta ek-cta--secondary"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '10px 16px', fontSize: '13px' }}
        >
          <Plus size={15} /> Agregar paso
        </button>
      </Section>

      <Section title="PREGUNTAS FRECUENTES" description="Las dudas comunes de tus clientes. Se muestran como acordeón en el landing.">
        <FormField label="Etiqueta superior">
          <input
            value={draft.faq.eyebrow}
            onChange={(e) => setDraft({ ...draft, faq: { ...draft.faq, eyebrow: e.target.value } })}
            className="ek-input"
            placeholder="PREGUNTAS FRECUENTES"
          />
        </FormField>
        <FormField label="Título">
          <input
            value={draft.faq.titulo}
            onChange={(e) => setDraft({ ...draft, faq: { ...draft.faq, titulo: e.target.value } })}
            className="ek-input"
            placeholder="Lo que probablemente quieres saber."
          />
        </FormField>

        {draft.faq.items.map((item, i) => (
          <div
            key={i}
            style={{ padding: '14px', marginBottom: '10px', background: 'var(--ek-bg-soft)', borderRadius: 'var(--ek-r-md)', border: '0.5px solid var(--ek-line)' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
              <span className="ek-eyebrow ek-eyebrow--mustard" style={{ fontSize: '11px' }}>PREGUNTA {i + 1}</span>
              <button
                type="button"
                onClick={() => removeFaq(i)}
                aria-label={`Eliminar pregunta ${i + 1}`}
                style={{ background: 'none', border: 'none', color: 'var(--ek-ink-faint)', cursor: 'pointer', padding: '4px' }}
              >
                <Trash2 size={15} />
              </button>
            </div>
            <input
              value={item.q}
              onChange={(e) => updateFaq(i, { q: e.target.value })}
              className="ek-input"
              placeholder="¿Pregunta?"
              style={{ marginBottom: '8px' }}
            />
            <textarea
              value={item.a}
              onChange={(e) => updateFaq(i, { a: e.target.value })}
              className="ek-input"
              rows={3}
              placeholder="Respuesta"
            />
          </div>
        ))}
        <button
          type="button"
          onClick={addFaq}
          className="ek-cta ek-cta--secondary"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '10px 16px', fontSize: '13px' }}
        >
          <Plus size={15} /> Agregar pregunta
        </button>
      </Section>

      <Section
        title="BOTÓN DEL DETALLE DE ESTUDIO"
        description="El botón que aparece dentro del modal cuando alguien abre un estudio."
      >
        <FormField label="Texto del botón">
          <input
            value={draft.estudio_modal.cta_texto}
            onChange={(e) => setDraft({ ...draft, estudio_modal: { ...draft.estudio_modal, cta_texto: e.target.value } })}
            className="ek-input"
            placeholder="Ver planes y reservar"
          />
        </FormField>
        <FormField label="A dónde lleva el botón" helper="URL o ruta interna (ej. /signup) o anchor (#membresias).">
          <input
            value={draft.estudio_modal.cta_link}
            onChange={(e) => setDraft({ ...draft, estudio_modal: { ...draft.estudio_modal, cta_link: e.target.value } })}
            className="ek-input"
            placeholder="/signup"
          />
        </FormField>
      </Section>

      <div style={{ display: 'flex', gap: '10px', position: 'sticky', bottom: '12px' }}>
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty || isSaving || loadError}
          className="ek-cta"
          style={{ padding: '14px 28px', fontSize: '14px' }}
        >
          {isSaving ? 'Guardando…' : 'Guardar cambios'}
        </button>
        <button
          type="button"
          onClick={handleDiscard}
          disabled={!dirty || isSaving || loadError}
          className="ek-cta ek-cta--secondary"
          style={{ padding: '14px 28px', fontSize: '14px' }}
        >
          Descartar
        </button>
      </div>
    </div>
  );
}
