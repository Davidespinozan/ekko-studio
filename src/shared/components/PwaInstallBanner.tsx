import { useEffect, useState } from 'react';
import { Download, X, Share } from 'lucide-react';

/**
 * Invita a instalar la PWA de EKKO en el teléfono / iPad.
 *   - Android/Chrome/Edge: usa el evento `beforeinstallprompt` (install nativo).
 *   - iOS Safari: no dispara ese evento → mostramos instrucciones manuales
 *     (Compartir → "Agregar a inicio").
 * No aparece si ya está instalada (display-mode standalone) o si el usuario lo
 * descartó antes (localStorage). Banner inferior, dismissible.
 */

const DISMISS_KEY = 'ekko:pwa-install-dismissed';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function yaInstalada(): boolean {
  if (typeof window === 'undefined') return false;
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches;
  const iosStandalone = (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  return Boolean(standalone || iosStandalone);
}

function esIOS(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = window.navigator.userAgent;
  return /iphone|ipad|ipod/i.test(ua) && !(window as unknown as { MSStream?: unknown }).MSStream;
}

export default function PwaInstallBanner() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [visible, setVisible] = useState(false);
  const [iosHelp, setIosHelp] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (yaInstalada()) return;
    try {
      if (localStorage.getItem(DISMISS_KEY)) return;
    } catch {
      // localStorage bloqueado (modo privado) → seguimos, sin recordar el dismiss.
    }

    if (esIOS()) {
      setVisible(true); // iOS: instrucciones manuales, sin beforeinstallprompt
      return;
    }

    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      setVisible(true);
    };
    const onInstalled = () => {
      setVisible(false);
      try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* noop */ }
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  function descartar() {
    setVisible(false);
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* noop */ }
  }

  async function instalar() {
    if (esIOS()) {
      setIosHelp((v) => !v);
      return;
    }
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    descartar();
  }

  if (!visible) return null;

  return (
    <div
      role="dialog"
      aria-label="Instalar la app de EKKO"
      style={{
        position: 'fixed',
        left: '12px',
        right: '12px',
        bottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)',
        zIndex: 250,
        maxWidth: '460px',
        margin: '0 auto',
        background: 'var(--ek-bg-elevated)',
        border: '0.5px solid var(--ek-mustard-dim)',
        borderRadius: 'var(--ek-r-md)',
        boxShadow: '0 16px 40px rgba(0, 0, 0, 0.5)',
        padding: '14px 14px 14px 16px'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
        <span className="ek-empty-icon" style={{ width: 40, height: 40, margin: 0, flexShrink: 0 }}>
          <Download size={18} aria-hidden="true" />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: 0, fontWeight: 700, fontSize: '14px', fontFamily: 'var(--ek-font-display)', letterSpacing: '-0.01em' }}>
            Instalá EKKO en tu teléfono
          </p>
          <p className="ek-body-muted" style={{ margin: '3px 0 0', fontSize: '12.5px', lineHeight: 1.4 }}>
            Acceso directo desde tu pantalla de inicio. Funciona como app nativa.
          </p>

          {esIOS() && iosHelp && (
            <p className="ek-body-muted" style={{ margin: '10px 0 0', fontSize: '12.5px', lineHeight: 1.5 }}>
              Tocá <Share size={13} style={{ verticalAlign: '-2px', color: 'var(--ek-mustard)' }} aria-hidden="true" /> Compartir
              y luego <strong style={{ color: 'var(--ek-ink)' }}>“Agregar a inicio”</strong>.
            </p>
          )}

          <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
            <button
              type="button"
              className="ek-cta ek-cta--gold"
              style={{ padding: '9px 16px', fontSize: '13px', minHeight: '38px' }}
              onClick={instalar}
            >
              {esIOS() ? (iosHelp ? 'Entendido' : 'Cómo instalar') : 'Instalar'}
            </button>
            <button
              type="button"
              className="ek-cta ek-cta--secondary"
              style={{ padding: '9px 14px', fontSize: '13px', minHeight: '38px' }}
              onClick={descartar}
            >
              Ahora no
            </button>
          </div>
        </div>
        <button
          type="button"
          className="ek-icon-btn ek-icon-btn--ghost ek-icon-btn--sm"
          aria-label="Cerrar"
          onClick={descartar}
          style={{ flexShrink: 0 }}
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
