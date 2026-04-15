/**
 * WidgetPanel - Sidebar container for all widgets
 */

import React from 'react';
import { PrioritiesWidget } from './PrioritiesWidget';
import { ContainersWidget } from './ContainersWidget';
import { SubagentsWidget } from './SubagentsWidget';
import { SchedulesWidget } from './SchedulesWidget';
import { WorkflowsWidget } from './WorkflowsWidget';
import { DomainsWidget } from './DomainsWidget';
import { Domain } from '../../hooks/useDomains';

interface WidgetPanelProps {
  domains: Domain[];
  activeDomain: string;
  onSwitchDomain: (domainId: string) => void;
}

export const WidgetPanel: React.FC<WidgetPanelProps> = ({
  domains,
  activeDomain,
  onSwitchDomain,
}) => {
  return (
    <aside id="widget-panel">
      <PrioritiesWidget />
      <ContainersWidget />
      <SubagentsWidget />
      <WorkflowsWidget />
      <SchedulesWidget />
      <DomainsWidget
        domains={domains}
        activeDomain={activeDomain}
        onSwitch={onSwitchDomain}
      />
    </aside>
  );
};
