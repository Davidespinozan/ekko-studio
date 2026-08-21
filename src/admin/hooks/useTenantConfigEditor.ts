import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@shared/lib/supabase';
import { useTenant } from '@shared/hooks/useTenant';

/**
 * Hook generalista para páginas de /admin/ajustes/* que leen y escriben
 * un sub-objeto del tenant.config en BD.
 *
 * - Lee el tenant.config completo en mount.
 * - Mantiene `draft` editable + `original` para comparar dirty state.
 * - Guarda haciendo merge no destructivo: { ...config, ...patch }, donde patch
 *   son las keys top-level que esta página gestiona.
 */
export function useTenantConfigEditor() {
  const tenant = useTenant();
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    setLoadError(false);
    const { data, error } = await supabase
      .from('tenants')
      .select('config')
      .eq('id', tenant.id)
      .single();

    if (error) {
      // NUNCA caer a {}: saveTopLevel haría { ...{}, ...patch } y borraría el
      // resto del config (contacto, landing, reglas…) al guardar cualquier
      // página. Con config=null el guardado queda bloqueado hasta recargar.
      console.error('[useTenantConfigEditor]', error);
      setConfig(null);
      setLoadError(true);
    } else {
      setConfig((data?.config as Record<string, unknown>) ?? {});
    }
    setIsLoading(false);
  }, [tenant.id]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Guarda un patch de top-level keys.
   * Ej: saveTopLevel({ contacto: {...}, landing: {...} })
   */
  const saveTopLevel = useCallback(
    async (patch: Record<string, unknown>) => {
      if (!config) return { error: 'No se pudo cargar la configuración actual; recarga antes de guardar para no perder datos.' };
      setIsSaving(true);
      const next = { ...config, ...patch };
      const { error } = await supabase
        .from('tenants')
        .update({ config: next as never })
        .eq('id', tenant.id);
      setIsSaving(false);
      if (error) return { error: error.message };
      setConfig(next);
      return { error: null };
    },
    [config, tenant.id]
  );

  return { config, isLoading, isSaving, loadError, saveTopLevel, reload: load };
}
