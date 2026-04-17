/**
 * Hook for managing domains
 */

import { useState, useEffect, useCallback } from 'react';

export interface Domain {
  id: string;
  label: string;
  type: string;
  triggers?: string[];
  createdAt?: number;
}

export interface DomainsState {
  domains: Domain[];
  activeDomain: string;
  loading: boolean;
  error: string | null;
}

export function useDomains() {
  const [state, setState] = useState<DomainsState>({
    domains: [],
    activeDomain: 'general',
    loading: true,
    error: null,
  });

  const loadDomains = useCallback(async function loadDomains() {
    try {
      const res = await fetch('/api/domains');
      if (!res.ok) {
        throw new Error('Failed to load domains');
      }
      const data = await res.json();
      setState({
        domains: data.domains ?? [],
        activeDomain: data.activeDomain ?? 'general',
        loading: false,
        error: null,
      });
    } catch (err) {
      setState(prev => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load domains',
      }));
    }
  }, []);

  useEffect(() => {
    loadDomains();
  }, [loadDomains]);

  async function switchDomain(domainId: string) {
    try {
      const res = await fetch(`/api/domains/${domainId}/activate`, {
        method: 'POST',
      });
      if (!res.ok) {
        throw new Error('Failed to switch domain');
      }
      setState(prev => ({
        ...prev,
        activeDomain: domainId,
      }));
      return true;
    } catch (err) {
      console.error('Failed to switch domain:', err);
      return false;
    }
  }

  return {
    ...state,
    switchDomain,
    reload: loadDomains,
  };
}
