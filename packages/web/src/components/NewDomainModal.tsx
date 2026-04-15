/**
 * NewDomainModal - Modal for creating a new domain
 */

import React, { useState } from 'react';

interface NewDomainModalProps {
  onClose: () => void;
  activeDomain: string;
}

export const NewDomainModal: React.FC<NewDomainModalProps> = ({ onClose, activeDomain }) => {
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [type, setType] = useState('project');
  const [triggers, setTriggers] = useState('');

  const handleCreate = async () => {
    if (!id.trim() || !label.trim()) {
      alert('ID and label are required');
      return;
    }

    const triggerKeywords = triggers
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    // Send a message to the agent asking to create the domain
    const text = `Create a new domain with id "${id}", label "${label}", type "${type}", and trigger keywords: ${triggerKeywords.join(', ') || 'none'}.`;

    try {
      const res = await fetch(`/api/messages/${activeDomain}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      if (res.ok) {
        onClose();
      } else {
        const err = await res.json().catch(() => ({ error: 'Failed to create domain' }));
        alert(err.error ?? 'Failed to create domain');
      }
    } catch (err) {
      alert('Network error: failed to create domain');
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Create New Domain</h2>
        <div className="field">
          <label>ID (lowercase, e.g. "fitness" or "work/acme")</label>
          <input
            type="text"
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="fitness"
          />
        </div>
        <div className="field">
          <label>Label</label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Fitness and nutrition tracking"
          />
        </div>
        <div className="field">
          <label>Type</label>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="project">project</option>
            <option value="work">work</option>
            <option value="personal">personal</option>
            <option value="general">general</option>
            <option value="system">system</option>
          </select>
        </div>
        <div className="field">
          <label>Trigger keywords (comma-separated)</label>
          <input
            type="text"
            value={triggers}
            onChange={(e) => setTriggers(e.target.value)}
            placeholder="fitness, workout, nutrition, health"
          />
        </div>
        <div className="modal-actions">
          <button className="btn-cancel" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={handleCreate}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
};
