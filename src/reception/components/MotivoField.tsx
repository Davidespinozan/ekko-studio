import { useState } from 'react';

const OTRO = 'Otro';

interface Props {
  /** Motivos predefinidos (sin "Otro" — se agrega solo). */
  opciones: string[];
  /** Emite el motivo resuelto (predefinido elegido o texto libre). */
  onChange: (motivo: string) => void;
  label?: string;
  idPrefix?: string;
}

/**
 * Campo de "Motivo del cambio" para acciones sensibles de recepción
 * (status / tier / desbloqueo). Lista predefinida + opción "Otro" con texto
 * libre. Emite siempre el motivo resuelto; el padre valida que no sea vacío.
 *
 * Mobile-first: selects/inputs con altura cómoda (clases ek-input).
 */
export function MotivoField({ opciones, onChange, label = 'Motivo del cambio', idPrefix = 'motivo' }: Props) {
  const [sel, setSel] = useState('');
  const [libre, setLibre] = useState('');

  function emit(nextSel: string, nextLibre: string) {
    onChange(nextSel === OTRO ? nextLibre.trim() : nextSel);
  }

  return (
    <div className="ek-form-field">
      <label className="ek-label" htmlFor={`${idPrefix}-sel`}>{label}</label>
      <select
        id={`${idPrefix}-sel`}
        className="ek-input"
        value={sel}
        onChange={(e) => {
          setSel(e.target.value);
          emit(e.target.value, libre);
        }}
      >
        <option value="" disabled>Elegí un motivo…</option>
        {opciones.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
        <option value={OTRO}>Otro (especificar)</option>
      </select>
      {sel === OTRO && (
        <input
          id={`${idPrefix}-libre`}
          className="ek-input"
          style={{ marginTop: '8px' }}
          placeholder="Escribí el motivo"
          value={libre}
          onChange={(e) => {
            setLibre(e.target.value);
            emit(OTRO, e.target.value);
          }}
          autoComplete="off"
          autoFocus
        />
      )}
    </div>
  );
}
