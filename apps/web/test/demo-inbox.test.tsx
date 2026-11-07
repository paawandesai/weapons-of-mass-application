import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { DemoMailboxMessage } from '@wma/shared';
import { Layout } from '../src/components/Layout';
import { DemoInboxPage } from '../src/pages/DemoInboxPage';
import { server } from './server';

const message = (over: Partial<DemoMailboxMessage> = {}): DemoMailboxMessage => ({
  id: 'm1',
  thread_id: 't1',
  direction: 'received',
  subject: 'Interview for Staff Platform Engineer at Harbor Robotics',
  from: 'Priya Natarajan <priya@harbor.example>',
  to: 'demo@wma.local',
  date: '2026-11-07T10:00:00.000Z',
  body_text: 'Confirm here: https://app.test/confirm/abc',
  body: [
    { type: 'text', value: 'Confirm here: ' },
    { type: 'link', value: 'https://app.test/confirm/abc' },
  ],
  ...over,
});

const me = (demo: boolean) =>
  http.get('/api/me', () =>
    HttpResponse.json({
      user: {
        id: 'u',
        email: 'demo@wma.local',
        display_name: 'Jordan',
        approved_profile_version: 1,
        approved_profile_at: null,
        daily_target: 8,
        digest_hour: 8,
      },
      connections: [],
      demo,
    }),
  );

describe('demo inbox', () => {
  it('lists messages with clickable links', async () => {
    server.use(
      http.get('/api/admin/demo-mailbox', () => HttpResponse.json({ messages: [message()] })),
    );
    render(
      <MemoryRouter>
        <DemoInboxPage />
      </MemoryRouter>,
    );
    expect(
      await screen.findByRole('heading', { name: /Interview for Staff Platform/ }),
    ).toBeVisible();
    const link = screen.getByRole('link', { name: 'https://app.test/confirm/abc' });
    expect(link).toHaveAttribute('href', 'https://app.test/confirm/abc');
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.getByText(/From Priya Natarajan/)).toBeVisible();
  });

  it('shows the empty state and refreshes on request', async () => {
    let calls = 0;
    server.use(
      http.get('/api/admin/demo-mailbox', () => {
        calls++;
        return HttpResponse.json({ messages: calls > 1 ? [message()] : [] });
      }),
    );
    render(
      <MemoryRouter>
        <DemoInboxPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('No mail yet.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('list', { name: 'Messages' })).toBeVisible();
  });

  it('shows an error when the mailbox cannot be read', async () => {
    server.use(
      http.get('/api/admin/demo-mailbox', () =>
        HttpResponse.json({ code: 'not_found', message: 'Not found' }, { status: 404 }),
      ),
    );
    render(
      <MemoryRouter>
        <DemoInboxPage />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('alert')).toBeVisible();
  });
});

describe('the Inbox link in the main navigation', () => {
  const renderLayout = () =>
    render(
      <MemoryRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<p>home</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

  it('is shown when the API reports the tenant is demo', async () => {
    server.use(me(true));
    renderLayout();
    expect(await screen.findByRole('link', { name: 'Inbox' })).toHaveAttribute(
      'href',
      '/demo/inbox',
    );
  });

  it('is absent for any other tenant', async () => {
    server.use(me(false));
    renderLayout();
    await screen.findByText('home');
    expect(screen.queryByRole('link', { name: 'Inbox' })).toBeNull();
  });
});
