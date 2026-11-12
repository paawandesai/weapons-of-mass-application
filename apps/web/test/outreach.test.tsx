import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { OutreachDraftView } from '@wma/shared';
import { OutreachPanel } from '../src/components/card-extras/OutreachPanel';
import { resetState, server, state } from './server';

void server;

const draft = (over: Partial<OutreachDraftView> = {}): OutreachDraftView => ({
  id: 'o1',
  application_id: 'a1',
  contact_name: 'Riley Park',
  contact_title: 'Recruiter',
  contact_profile_url: null,
  to_address: 'riley.park@example.com',
  subject: 'Backend Engineer',
  body_text: 'Hi Riley, I would like to talk about the role.',
  linkedin_note: 'Hi Riley, I applied for the role.',
  state: 'draft',
  content_hash: 'h'.repeat(64),
  approved_at: null,
  sent_at: null,
  failure_reason: null,
  created_at: '2026-11-06T10:00:00.000Z',
  ...over,
});

beforeEach(() => resetState());

describe('OutreachPanel', () => {
  it('shows the draft as waiting for approval, with the daily count', async () => {
    state.outreach = [draft()];
    render(<OutreachPanel applicationId="a1" />);
    expect(await screen.findByText('Waiting for your approval')).toBeInTheDocument();
    expect(screen.getByDisplayValue('riley.park@example.com')).toBeInTheDocument();
    expect(screen.getByText(/1 of 5 outreach emails sent today/)).toBeInTheDocument();
  });

  it('needs a second click before it approves, and approves the hash it showed', async () => {
    state.outreach = [draft()];
    const user = userEvent.setup();
    render(<OutreachPanel applicationId="a1" />);
    await user.click(await screen.findByRole('button', { name: 'Approve and send' }));
    expect(state.outreachCalls.approved).toEqual([]);
    expect(
      screen.getByText(/Send this exact message to riley.park@example.com/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Yes, send it' }));
    await waitFor(() => expect(state.outreachCalls.approved).toEqual(['o1']));
  });

  it('cancelling the confirmation approves nothing', async () => {
    state.outreach = [draft()];
    const user = userEvent.setup();
    render(<OutreachPanel applicationId="a1" />);
    await user.click(await screen.findByRole('button', { name: 'Approve and send' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(state.outreachCalls.approved).toEqual([]);
  });

  it('a stale draft shows the server message instead of sending', async () => {
    state.outreach = [draft()];
    const user = userEvent.setup();
    render(<OutreachPanel applicationId="a1" />);
    await user.click(await screen.findByRole('button', { name: 'Approve and send' }));
    state.outreach[0]!.content_hash = 'x'.repeat(64);
    await user.click(screen.getByRole('button', { name: 'Yes, send it' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('changed since you opened it');
    expect(state.outreachCalls.approved).toEqual([]);
  });

  it('cannot approve unsaved edits', async () => {
    state.outreach = [draft()];
    const user = userEvent.setup();
    render(<OutreachPanel applicationId="a1" />);
    const body = await screen.findByLabelText(/Message/);
    await user.type(body, ' extra');
    expect(screen.getByRole('button', { name: 'Approve and send' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });

  it('a sent draft has no approve button', async () => {
    state.outreach = [draft({ state: 'sent', sent_at: '2026-11-06T10:05:00.000Z' })];
    render(<OutreachPanel applicationId="a1" />);
    expect(await screen.findByText('Sent')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve and send' })).toBeNull();
  });

  it('explains why a draft was not sent', async () => {
    state.outreach = [draft({ state: 'failed', failure_reason: 'daily_cap' })];
    render(<OutreachPanel applicationId="a1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('the daily limit was reached');
  });

  it('asks for a draft from a contact the user typed', async () => {
    const user = userEvent.setup();
    render(<OutreachPanel applicationId="a1" />);
    await user.type(await screen.findByLabelText('Name'), 'Riley Park');
    await user.type(screen.getByLabelText('Email'), 'riley.park@example.com');
    await user.click(screen.getByRole('button', { name: 'Write a draft' }));
    await waitFor(() =>
      expect(state.outreachCalls.requested).toEqual([
        {
          application_id: 'a1',
          contact: {
            name: 'Riley Park',
            title: null,
            profile_url: null,
            email: 'riley.park@example.com',
          },
        },
      ]),
    );
    expect(await screen.findByText(/Writing a draft/)).toBeInTheDocument();
  });
});
