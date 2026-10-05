/**
 * @jest-environment jsdom
 */
import { FormProvider, useForm } from 'react-hook-form';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import type { AgentForm } from '~/common';
import AdvancedPanel from '../AdvancedPanel';

const mockShowToast = jest.fn();
let mockStartupConfig: { serverDomain: string; a2aServerEnabled?: boolean } | undefined;

jest.mock('@librechat/client', () => ({
  Button: ({ children, ...props }: { children: ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  TooltipAnchor: ({ render }: { render: ReactElement }) => render,
  labelVariants: () => '',
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: mockStartupConfig }),
}));

jest.mock('~/Providers', () => ({
  useAgentPanelContext: () => ({ setActivePanel: jest.fn() }),
}));

jest.mock('../OrchestrationHub', () => ({ __esModule: true, default: () => null }));
jest.mock('../MaxAgentSteps', () => ({ __esModule: true, default: () => null }));

function Harness({ agentId }: { agentId: string }) {
  const methods = useForm<AgentForm>({ defaultValues: { id: agentId } as AgentForm });
  return (
    <FormProvider {...methods}>
      <AdvancedPanel />
    </FormProvider>
  );
}

const cardUrl = 'https://chat.example.com/api/a2a/agents/agent_x/.well-known/agent-card.json';

describe('AdvancedPanel A2A card URL', () => {
  const writeText = jest.fn();

  beforeEach(() => {
    mockShowToast.mockReset();
    writeText.mockReset();
    Object.assign(navigator, { clipboard: { writeText } });
    mockStartupConfig = { serverDomain: 'https://chat.example.com', a2aServerEnabled: true };
  });

  it('shows the agent card URL while A2A serving is enabled', () => {
    render(<Harness agentId="agent_x" />);

    expect(screen.getByText('com_ui_a2a_card_url')).toBeTruthy();
    expect(screen.getByText(cardUrl)).toBeTruthy();
  });

  it('hides it while A2A serving is disabled', () => {
    mockStartupConfig = { serverDomain: 'https://chat.example.com', a2aServerEnabled: false };
    render(<Harness agentId="agent_x" />);

    expect(screen.queryByText('com_ui_a2a_card_url')).toBeNull();
    expect(screen.getByText('com_ui_agent_id')).toBeTruthy();
  });

  it('copies the URL and confirms it', async () => {
    writeText.mockResolvedValue(undefined);
    render(<Harness agentId="agent_x" />);

    fireEvent.click(screen.getByLabelText('com_ui_a2a_card_url_copy'));

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith({
        message: 'com_ui_a2a_card_url_copied',
        status: 'success',
      }),
    );
    expect(writeText).toHaveBeenCalledWith(cardUrl);
  });

  it('reports a failed copy', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    render(<Harness agentId="agent_x" />);

    fireEvent.click(screen.getByLabelText('com_ui_a2a_card_url_copy'));

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith({ message: 'com_ui_error', status: 'error' }),
    );
  });
});
