import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

interface Props {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: string;
  required?: boolean;
  autoFocus?: boolean;
  minLength?: number;
}

/** Input de contraseña con botón mostrar/ocultar (mismo patrón que el login). */
export function PasswordInput({ id, value, onChange, placeholder = '••••••••', autoComplete = 'new-password', required, autoFocus, minLength }: Props) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <input
        id={id}
        type={show ? 'text' : 'password'}
        autoComplete={autoComplete}
        required={required}
        autoFocus={autoFocus}
        minLength={minLength}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="ek-input"
        placeholder={placeholder}
        style={{ paddingRight: '48px' }}
      />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        className="ek-icon-btn ek-icon-btn--ghost ek-icon-btn--sm"
        aria-label={show ? 'Ocultar contraseña' : 'Mostrar contraseña'}
        style={{ position: 'absolute', right: '6px', top: '50%', transform: 'translateY(-50%)' }}
      >
        {show ? <EyeOff size={18} /> : <Eye size={18} />}
      </button>
    </div>
  );
}
