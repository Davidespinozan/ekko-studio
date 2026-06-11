import { useState } from 'react';
import { Pencil, Trash2, Check, X } from 'lucide-react';
import { useAuth } from '@shared/hooks/useAuth';
import { useToast } from '@shared/hooks/useToast';
import { Spinner } from '@shared/components/Spinner';
import { useNotasMiembro, type NotaMiembro } from '@shared/hooks/useNotasMiembro';

/**
 * Bitácora operativa del miembro (Bloque E). Lista + alta + edición/borrado de
 * notas humanas compartidas entre admin y recepción. Separada del "Historial de
 * cambios" (audit_log inmutable): esto es colaboración editable.
 */

function fechaHora(iso: string): string {
  return new Date(iso).toLocaleString('es-MX', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

function autorLabel(rol: string, nombre: string | null | undefined): string {
  const r = rol === 'admin' ? 'Admin' : rol === 'recepcionista' ? 'Recepción' : rol;
  return nombre ? `${nombre} · ${r}` : r;
}

export function NotasMiembro({ miembroId }: { miembroId: string | undefined }) {
  const { usuario } = useAuth();
  const toast = useToast();
  const { notas, isLoading, error, createNota, updateNota, deleteNota } = useNotasMiembro(miembroId);
  const [nueva, setNueva] = useState('');
  const [guardando, setGuardando] = useState(false);

  const puedeEditar = (n: NotaMiembro) =>
    usuario != null && (n.autor_id === usuario.id || usuario.rol === 'admin');

  async function agregar() {
    if (!nueva.trim()) return;
    setGuardando(true);
    try {
      await createNota(nueva.trim());
      setNueva('');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo guardar la nota.');
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <textarea
          value={nueva}
          onChange={(e) => setNueva(e.target.value)}
          placeholder="Agregá una nota sobre el miembro…"
          className="ek-input"
          rows={2}
          style={{ width: '100%', resize: 'vertical', minHeight: '56px' }}
          aria-label="Nueva nota"
        />
        <button
          type="button"
          onClick={agregar}
          disabled={guardando || !nueva.trim()}
          className="ek-cta ek-cta--gold"
          style={{ minHeight: '44px', marginTop: '8px', opacity: !nueva.trim() ? 0.5 : 1 }}
        >
          {guardando ? <Spinner size={16} /> : 'Agregar nota'}
        </button>
      </div>

      {isLoading ? (
        <div className="ek-skeleton" style={{ height: '60px', borderRadius: 'var(--ek-r-sm)' }} />
      ) : error ? (
        <p className="ek-body-faint">No se pudieron cargar las notas.</p>
      ) : notas.length === 0 ? (
        <p className="ek-body-faint" style={{ fontSize: '13px' }}>
          Sin notas. Usá este espacio para apuntar cosas que recepción o admin deba recordar sobre
          el miembro.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {notas.map((n) => (
            <NotaItem
              key={n.id}
              nota={n}
              editable={puedeEditar(n)}
              onUpdate={updateNota}
              onDelete={deleteNota}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function NotaItem({
  nota,
  editable,
  onUpdate,
  onDelete
}: {
  nota: NotaMiembro;
  editable: boolean;
  onUpdate: (id: string, contenido: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const toast = useToast();
  const [editando, setEditando] = useState(false);
  const [borrando, setBorrando] = useState(false);
  const [texto, setTexto] = useState(nota.contenido);
  const [busy, setBusy] = useState(false);

  async function guardar() {
    if (!texto.trim()) return;
    setBusy(true);
    try {
      await onUpdate(nota.id, texto.trim());
      setEditando(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo editar.');
    } finally {
      setBusy(false);
    }
  }

  async function confirmarBorrado() {
    setBusy(true);
    try {
      await onDelete(nota.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo borrar.');
      setBusy(false);
      setBorrando(false);
    }
  }

  return (
    <div
      style={{
        padding: '10px 14px',
        background: 'var(--ek-bg-soft)',
        border: '0.5px solid var(--ek-line)',
        borderRadius: 'var(--ek-r-sm)'
      }}
    >
      {editando ? (
        <>
          <textarea
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            className="ek-input"
            rows={2}
            style={{ width: '100%', resize: 'vertical' }}
            aria-label="Editar nota"
          />
          <div style={{ display: 'flex', gap: '6px', marginTop: '6px', justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => { setEditando(false); setTexto(nota.contenido); }} className="ek-icon-btn ek-icon-btn--sm" aria-label="Cancelar edición" disabled={busy}>
              <X size={15} aria-hidden="true" />
            </button>
            <button type="button" onClick={guardar} className="ek-icon-btn ek-icon-btn--sm" aria-label="Guardar nota" disabled={busy || !texto.trim()}>
              <Check size={15} aria-hidden="true" />
            </button>
          </div>
        </>
      ) : (
        <>
          <p style={{ fontSize: '13px', color: 'var(--ek-ink)', margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>
            {nota.contenido}
          </p>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '6px', gap: '8px' }}>
            <span style={{ fontSize: '11px', color: 'var(--ek-ink-faint)' }}>
              {autorLabel(nota.autor_rol, nota.autor?.nombre)} · {fechaHora(nota.creada_at)}
              {nota.actualizada_at ? ' · editada' : ''}
            </span>
            {editable && !borrando && (
              <span style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                <button type="button" onClick={() => { setTexto(nota.contenido); setEditando(true); }} className="ek-icon-btn ek-icon-btn--ghost ek-icon-btn--sm" aria-label="Editar nota">
                  <Pencil size={14} aria-hidden="true" />
                </button>
                <button type="button" onClick={() => setBorrando(true)} className="ek-icon-btn ek-icon-btn--ghost ek-icon-btn--sm" aria-label="Borrar nota">
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </span>
            )}
            {editable && borrando && (
              <span style={{ display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0 }}>
                <span style={{ fontSize: '11px', color: 'var(--ek-danger)' }}>¿Borrar?</span>
                <button type="button" onClick={() => setBorrando(false)} className="ek-icon-btn ek-icon-btn--sm" aria-label="No borrar" disabled={busy}>
                  <X size={14} aria-hidden="true" />
                </button>
                <button type="button" onClick={confirmarBorrado} className="ek-icon-btn ek-icon-btn--sm" aria-label="Confirmar borrado" disabled={busy} style={{ color: 'var(--ek-danger)' }}>
                  <Check size={14} aria-hidden="true" />
                </button>
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
