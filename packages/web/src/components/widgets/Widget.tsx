/**
 * Widget - Base collapsible widget card
 */

import React, { useState, useEffect } from 'react';

interface WidgetProps {
  id: string;
  title: string;
  icon?: string;
  children: React.ReactNode;
  refreshable?: boolean;
  onRefresh?: () => void;
  updatedAt?: Date | null;
}

export const Widget: React.FC<WidgetProps> = ({
  id,
  title,
  icon = '',
  children,
  refreshable = false,
  onRefresh,
  updatedAt,
}) => {
  const [collapsed, setCollapsed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Load collapsed state from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem('collapsed-widgets');
      if (stored) {
        const collapsedIds = JSON.parse(stored) as string[];
        if (collapsedIds.includes(id)) {
          setCollapsed(true);
        }
      }
    } catch {
      // ignore
    }
  }, [id]);

  // Save collapsed state to localStorage
  const handleToggle = () => {
    const newCollapsed = !collapsed;
    setCollapsed(newCollapsed);

    try {
      const stored = localStorage.getItem('collapsed-widgets');
      let collapsedIds: string[] = stored ? JSON.parse(stored) : [];

      if (newCollapsed) {
        if (!collapsedIds.includes(id)) {
          collapsedIds.push(id);
        }
      } else {
        collapsedIds = collapsedIds.filter((cid) => cid !== id);
      }

      localStorage.setItem('collapsed-widgets', JSON.stringify(collapsedIds));
    } catch {
      // ignore
    }
  };

  const handleRefresh = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onRefresh || refreshing) return;

    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setTimeout(() => setRefreshing(false), 300);
    }
  };

  return (
    <div className={`widget ${collapsed ? 'collapsed' : ''}`}>
      <div className="widget-header" onClick={handleToggle}>
        <span>
          {icon} {title}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {updatedAt && (
            <span style={{ fontSize: '10px', fontWeight: 400 }}>
              {updatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          {refreshable && (
            <span
              className={`refresh-btn ${refreshing ? 'spinning' : ''}`}
              onClick={handleRefresh}
              title={`Refresh ${title}`}
            >
              ↻
            </span>
          )}
          <span className="widget-toggle">▾</span>
        </span>
      </div>
      <div className="widget-body">{children}</div>
    </div>
  );
};
