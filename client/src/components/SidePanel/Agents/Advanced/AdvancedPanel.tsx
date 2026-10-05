import { ChevronLeft } from 'lucide-react';
import { Button } from '@librechat/client';
import { useFormContext } from 'react-hook-form';
import { getA2AAgentCardUrl } from 'librechat-data-provider';
import type { AgentForm } from '~/common';
import { useGetStartupConfig } from '~/data-provider';
import { useAgentPanelContext } from '~/Providers';
import OrchestrationHub from './OrchestrationHub';
import MaxAgentSteps from './MaxAgentSteps';
import { groupHeadingClass } from './ui';
import { useLocalize } from '~/hooks';
import CopyField from './CopyField';
import { Panel } from '~/common';

export default function AdvancedPanel() {
  const localize = useLocalize();
  const { watch } = useFormContext<AgentForm>();
  const currentAgentId = watch('id');
  const { data: startupConfig } = useGetStartupConfig();

  const { setActivePanel } = useAgentPanelContext();

  const a2aCardUrl =
    currentAgentId && startupConfig?.a2aServerEnabled === true
      ? getA2AAgentCardUrl(startupConfig.serverDomain, currentAgentId)
      : undefined;

  return (
    <div className="mb-1 flex w-full flex-col gap-4 text-sm">
      <header className="grid grid-cols-[auto_1fr_auto] items-center gap-2 pt-1">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setActivePanel(Panel.builder)}
          aria-label={localize('com_ui_back_to_builder')}
          className="h-10 w-10 flex-shrink-0 rounded-xl border border-border-light text-text-secondary hover:bg-surface-secondary hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-text-primary"
        >
          <ChevronLeft className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
        </Button>
        <h2 className="text-center text-base font-semibold text-text-primary">
          {localize('com_ui_advanced_settings')}
        </h2>
        <span aria-hidden="true" className="h-10 w-10" />
      </header>

      <div className="flex flex-col gap-5 px-2 pb-2">
        <section className="flex flex-col gap-3">
          <span className={groupHeadingClass}>{localize('com_ui_essentials')}</span>
          <MaxAgentSteps />
        </section>

        <OrchestrationHub currentAgentId={currentAgentId} />

        {currentAgentId && (
          <div className="flex flex-col gap-2 border-t border-border-light pt-3">
            <CopyField
              label={localize('com_ui_agent_id')}
              value={currentAgentId}
              copyLabel={localize('com_ui_agent_id_copy')}
              copiedMessage={localize('com_ui_agent_id_copied')}
            />
            {a2aCardUrl && (
              <CopyField
                label={localize('com_ui_a2a_card_url')}
                value={a2aCardUrl}
                copyLabel={localize('com_ui_a2a_card_url_copy')}
                copiedMessage={localize('com_ui_a2a_card_url_copied')}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
