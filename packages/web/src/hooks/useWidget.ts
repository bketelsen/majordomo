/**
 * Hook for polling widget data
 */

import { useState, useEffect, useCallback } from 'react';

export function useWidget<T = any>(name: string, intervalMs: number) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/widgets/${name}`);
      if (res.ok) {
        const json = await res.json();
        setData(json.data);
        setUpdatedAt(new Date());
        setLoading(false);
      }
    } catch (err) {
      console.error(`Failed to load widget ${name}:`, err);
      setLoading(false);
    }
  }, [name]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, intervalMs);
    return () => clearInterval(timer);
  }, [refresh, intervalMs]);

  return { data, loading, refresh, updatedAt };
}
