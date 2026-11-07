import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { ApplicationDetail, BoardCardData, BoardData, SearchResult } from '../src/api';
import { App } from '../src/App';
import { server } from './server';

const NOW = '2026-11-06T10:00:00.000Z';

function card(over: Partial<BoardCardData> & { id: string }): BoardCardData {
  return {
    status: 'applied',
    badge: null,
    company: 'Acme Robotics',
    title: 'Staff Engineer',
    location_mode: 'remote',
    pay_min: 150000,
    pay_max: 190000,
    currency: 'USD',
    applied_at: '2026-11-02T09:00:00.000Z',
    last_activity_at: NOW,
    ...over,
  };
}

function boardOf(over: Partial<BoardData['columns']> = {}): BoardData {
  return { columns: { applied: [], interviewing: [], offer: [], closed: [], ...over } };
}

const detail = (over: Partial<ApplicationDetail> = {}): ApplicationDetail => ({
  id: 'a1',
  status: 'applied',
  pending_reason: null,
  closed_reason: null,
  applied_at: '2026-11-02T09:00:00.000Z',
  last_activity_at: NOW,
  job: {
    id: 'j1',
    title: 'Staff Engineer',
    url: 'https://example.test/job',
    ats: 'greenhouse',
    company: 'Acme Robotics',
    location: 'Remote',
    location_mode: 'remote',
    pay_min: 150000,
    pay_max: 190000,
    currency: 'USD',
    posted_at: null,
  },
  decision: { rationale: 'Strong platform match', seniority: 'staff' },
  resume: { ref: 'tenants/t/applications/a1/resume.pdf' },
  form_answers: [{ question: 'Full name', status: 'filled', value: 'Mara Quill' }],
  unmet_requirements: [],
  threads: [
    {
      id: 't1',
      subject: 'Interview times',
      kind: 'interview',
      compensation_flag: false,
      booking_link: null,
      last_message_at: NOW,
      messages: [{ id: 'm1', from: 'Rae <rae@acme.test>', at: NOW, body: 'Here are three times.' }],
    },
  ],
  outgoing: [],
  activity: [{ id: 'e1', at: NOW, actor: 'agent', action: 'submitted', detail: {} }],
  activity_next: null,
  interviews: [],
  prep_plan: null,
  feedback: null,
  negotiation: null,
  ...over,
});

function useBoard(data: BoardData) {
  server.use(
    http.get('*/api/board', () => HttpResponse.json(data)),
    http.get('*/api/interviews/for-application/:id', () =>
      HttpResponse.json({ interviews: [], negotiation: null }),
    ),
  );
}

function renderBoard(path = '/board') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

const column = (name: string) => screen.getByRole('region', { name });

describe('board', () => {
  it('renders four columns, the card fields and the pending badge', async () => {
    useBoard(
      boardOf({
        applied: [
          card({ id: 'a1' }),
          card({
            id: 'p1',
            status: 'pending',
            badge: 'pending',
            company: 'Pendco',
            pay_min: null,
            pay_max: null,
            location_mode: null,
          }),
        ],
        interviewing: [card({ id: 'i1', status: 'interviewing', company: 'Intco' })],
        closed: [card({ id: 'c1', status: 'closed', company: 'Closeco' })],
      }),
    );
    renderBoard();
    await screen.findByText('Acme Robotics');
    for (const name of ['Applied', 'Interviewing', 'Offer', 'Closed'])
      expect(column(name)).toBeInTheDocument();
    const applied = within(column('Applied'));
    expect(applied.getByText('Acme Robotics')).toBeInTheDocument();
    const acme = within(applied.getByText('Acme Robotics').closest('article')!);
    expect(acme.getByText('Staff Engineer')).toBeInTheDocument();
    expect(acme.getByText('Remote')).toBeInTheDocument();
    expect(acme.getByText(/\$150,000 – \$190,000/)).toBeInTheDocument();
    const pending = applied.getByText('Pendco').closest('article')!;
    expect(within(pending).getByText('Pending')).toBeInTheDocument();
    expect(within(pending).getAllByText('Not listed')).toHaveLength(2);
    expect(within(column('Interviewing')).getByText('Intco')).toBeInTheDocument();
    expect(within(column('Closed')).getByText('Closeco')).toBeInTheDocument();
    expect(within(column('Offer')).queryByRole('article')).toBeNull();
  });

  it('renders empty columns without an error', async () => {
    useBoard(boardOf());
    renderBoard();
    await screen.findByRole('region', { name: 'Offer' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('dragging a card to Closed calls the stage endpoint and keeps it there', async () => {
    useBoard(boardOf({ applied: [card({ id: 'a1' })] }));
    const calls: unknown[] = [];
    server.use(
      http.post('*/api/applications/:id/stage', async ({ request, params }) => {
        calls.push({ id: params.id, body: await request.json() });
        return HttpResponse.json({ id: 'a1', status: 'closed' });
      }),
    );
    renderBoard();
    const el = (await screen.findByText('Acme Robotics')).closest('article')!;
    fireEvent.dragStart(el);
    fireEvent.dragOver(column('Closed'));
    fireEvent.drop(column('Closed'));
    await waitFor(() =>
      expect(within(column('Closed')).getByText('Acme Robotics')).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(calls).toEqual([{ id: 'a1', body: { from: 'applied', to: 'closed' } }]),
    );
    expect(within(column('Applied')).queryByText('Acme Robotics')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('puts the card back and shows a toast when the save fails', async () => {
    useBoard(boardOf({ applied: [card({ id: 'a1' })] }));
    server.use(
      http.post('*/api/applications/:id/stage', () =>
        HttpResponse.json({ code: 'internal', message: 'Something went wrong' }, { status: 500 }),
      ),
    );
    renderBoard();
    const el = (await screen.findByText('Acme Robotics')).closest('article')!;
    fireEvent.dragStart(el);
    fireEvent.drop(column('Closed'));
    const toast = await screen.findByRole('alert');
    expect(toast).toHaveTextContent(/could not be moved/i);
    await waitFor(() =>
      expect(within(column('Applied')).getByText('Acme Robotics')).toBeInTheDocument(),
    );
    expect(within(column('Closed')).queryByText('Acme Robotics')).toBeNull();
  });

  it('refreshes the board and tells the user when the card changed elsewhere (409)', async () => {
    let loads = 0;
    server.use(
      http.get('*/api/board', () => {
        loads++;
        return HttpResponse.json(
          loads === 1
            ? boardOf({ applied: [card({ id: 'a1' })] })
            : boardOf({ interviewing: [card({ id: 'a1', status: 'interviewing' })] }),
        );
      }),
      http.post('*/api/applications/:id/stage', () =>
        HttpResponse.json(
          {
            code: 'stage_conflict',
            message: 'This card was updated elsewhere.',
            current: 'interviewing',
          },
          { status: 409 },
        ),
      ),
    );
    renderBoard();
    const el = (await screen.findByText('Acme Robotics')).closest('article')!;
    fireEvent.dragStart(el);
    fireEvent.drop(column('Closed'));
    expect(await screen.findByRole('alert')).toHaveTextContent('updated elsewhere');
    await waitFor(() =>
      expect(within(column('Interviewing')).getByText('Acme Robotics')).toBeInTheDocument(),
    );
  });

  it('the move menu moves a card without dragging', async () => {
    useBoard(boardOf({ applied: [card({ id: 'a1' })] }));
    server.use(
      http.post('*/api/applications/:id/stage', () =>
        HttpResponse.json({ id: 'a1', status: 'offer' }),
      ),
    );
    renderBoard();
    await userEvent.selectOptions(await screen.findByLabelText('Move Acme Robotics to'), 'offer');
    await waitFor(() =>
      expect(within(column('Offer')).getByText('Acme Robotics')).toBeInTheDocument(),
    );
  });
});

describe('card detail', () => {
  it('opens from a card and shows resume, answers, thread and activity', async () => {
    useBoard(boardOf({ applied: [card({ id: 'a1' })] }));
    server.use(http.get('*/api/applications/a1', () => HttpResponse.json(detail())));
    renderBoard();
    await userEvent.click(await screen.findByRole('button', { name: 'Acme Robotics' }));
    const dialog = await screen.findByRole('dialog', { name: 'Card detail' });
    expect(await within(dialog).findByText('resume.pdf')).toBeInTheDocument();
    expect(within(dialog).getByText('Mara Quill')).toBeInTheDocument();
    expect(within(dialog).getByText('Here are three times.')).toBeInTheDocument();
    expect(within(dialog).getByText('submitted')).toBeInTheDocument();
    expect(within(dialog).getByText('Strong platform match')).toBeInTheDocument();
    expect(await within(dialog).findByText(/no prep plan/i)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('labels inferred and guessed answers and leaves plain ones alone (rule 30)', async () => {
    useBoard(boardOf({ applied: [card({ id: 'a1' })] }));
    server.use(
      http.get('*/api/applications/a1', () =>
        HttpResponse.json(
          detail({
            form_answers: [
              { question: 'Full name', status: 'filled', value: 'Mara Quill' },
              {
                question: 'Work authorization',
                status: 'filled',
                value: 'Authorized to work in the United States',
                source: 'inferred',
              },
              { question: 'Years of Kafka', status: 'filled', value: 'About 5', source: 'guessed' },
            ],
          }),
        ),
      ),
    );
    renderBoard();
    await userEvent.click(await screen.findByRole('button', { name: 'Acme Robotics' }));
    const dialog = await screen.findByRole('dialog', { name: 'Card detail' });
    expect(
      await within(dialog).findByText(/Authorized to work in the United States/),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/About 5/)).toBeInTheDocument();
    expect(
      within(dialog).getAllByText('Answered by inference, correct it in your profile if wrong'),
    ).toHaveLength(2);
  });

  it('renders as a page at /applications/:id and shows not found for another tenant', async () => {
    server.use(
      http.get('*/api/applications/zzz', () =>
        HttpResponse.json({ code: 'not_found', message: 'Application not found' }, { status: 404 }),
      ),
    );
    renderBoard('/applications/zzz');
    expect(await screen.findByText(/could not be found/i)).toBeInTheDocument();
  });
});

describe('panic search', () => {
  const hit: SearchResult = {
    application_id: 'a1',
    company: 'Acme Robotics',
    title: 'Staff Engineer',
    status: 'applied',
    column: 'applied',
    badge: null,
  };

  it('shows matches, opens the card and highlights it', async () => {
    useBoard(boardOf({ applied: [card({ id: 'a1' }), card({ id: 'a2', company: 'Globex' })] }));
    const queries: string[] = [];
    server.use(
      http.get('*/api/search/companies', ({ request }) => {
        queries.push(new URL(request.url).searchParams.get('q') ?? '');
        return HttpResponse.json({ results: [hit] });
      }),
      http.get('*/api/applications/a1', () => HttpResponse.json(detail())),
    );
    renderBoard();
    await screen.findByText('Globex');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Find a company' }), 'acm');
    const list = await screen.findByRole('list', { name: 'Search results' });
    expect(within(list).getByText('Staff Engineer')).toBeInTheDocument();
    await userEvent.click(within(list).getByRole('button'));
    expect(await screen.findByRole('dialog', { name: 'Card detail' })).toBeInTheDocument();
    const highlighted = document.querySelector('[data-highlighted="true"]')!;
    expect(highlighted).toHaveAttribute('data-card-id', 'a1');
    expect(document.querySelectorAll('[data-highlighted="true"]')).toHaveLength(1);
    expect(queries.at(-1)).toBe('acm');
  });

  it('says nothing matched and keeps the board visible', async () => {
    useBoard(boardOf({ applied: [card({ id: 'a1' })] }));
    server.use(http.get('*/api/search/companies', () => HttpResponse.json({ results: [] })));
    renderBoard();
    await screen.findByText('Acme Robotics');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Find a company' }), 'zzz');
    expect(await screen.findByText(/nothing matched/i)).toBeInTheDocument();
    expect(screen.getByText('Acme Robotics')).toBeInTheDocument();
  });

  it('does not search for a single character', async () => {
    useBoard(boardOf());
    let called = 0;
    server.use(
      http.get('*/api/search/companies', () => {
        called++;
        return HttpResponse.json({ results: [] });
      }),
    );
    renderBoard();
    await userEvent.type(await screen.findByRole('searchbox', { name: 'Find a company' }), 'a');
    await new Promise((r) => setTimeout(r, 400));
    expect(called).toBe(0);
    expect(screen.queryByText(/nothing matched/i)).toBeNull();
  });
});
