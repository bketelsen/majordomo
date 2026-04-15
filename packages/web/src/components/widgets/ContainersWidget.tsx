/**
 * ContainersWidget - Shows Docker/Podman containers
 */

import React from 'react';
import { useWidget } from '../../hooks/useWidget';
import { Widget } from './Widget';

interface Container {
  id: string;
  name: string;
  image: string;
  status: string;
  runtime: string;
  running: boolean;
  ports: string[];
}

interface ContainersData {
  containers: Container[];
  updatedAt?: string;
}

const escapeHtml = (text: string) => {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
};

export const ContainersWidget: React.FC = () => {
  const { data, loading, refresh, updatedAt } = useWidget<ContainersData>('containers', 30000);

  const handleContainerAction = async (runtime: string, id: string, action: string) => {
    try {
      const res = await fetch(`/api/containers/${runtime}/${id}/${action}`, {
        method: 'POST',
      });
      if (res.ok) {
        setTimeout(() => refresh(), 1500);
      } else {
        alert(`Failed to ${action} container`);
      }
    } catch (err) {
      alert(`Failed to ${action} container`);
    }
  };

  const containers = data?.containers ?? [];

  return (
    <Widget
      id="widget-containers"
      title="Containers"
      icon="🐋"
      refreshable
      onRefresh={refresh}
      updatedAt={updatedAt}
    >
      {loading ? (
        <div className="empty">Loading…</div>
      ) : containers.length === 0 ? (
        <div className="empty">No containers found</div>
      ) : (
        containers.map((c) => (
          <div key={c.id} className="container-item">
            <div className="container-row">
              <span className={c.running ? 'status-dot-run' : 'status-dot-stop'} />
              <span className="container-name" title={c.name}>
                {escapeHtml(c.name)}
              </span>
              <span className="container-badge">{c.runtime}</span>
              {c.running ? (
                <button
                  className="action-btn danger"
                  onClick={() => handleContainerAction(c.runtime, c.id, 'stop')}
                >
                  Stop
                </button>
              ) : (
                <button
                  className="action-btn"
                  onClick={() => handleContainerAction(c.runtime, c.id, 'start')}
                >
                  Start
                </button>
              )}
            </div>
            <div className="container-image">
              {escapeHtml(c.image)} · {escapeHtml(c.status)}
            </div>
            {c.ports.length > 0 && (
              <div className="container-ports">{c.ports.slice(0, 3).join(' · ')}</div>
            )}
          </div>
        ))
      )}
    </Widget>
  );
};
