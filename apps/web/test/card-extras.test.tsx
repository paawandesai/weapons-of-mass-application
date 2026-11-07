import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Feedback, InterviewView, NegotiationView, PrepPlan } from '../src/api';
import { CardExtras } from '../src/components/card-extras';
import { FeedbackPage } from '../src/pages/FeedbackPage';
import { PrepPlanPage } from '../src/pages/PrepPlanPage';
import { server } from './server';

const plan: PrepPlan = {
  likely_questions: [{ question: 'Tell us about scaling.', answer_outline: 'Use the fleet work.' }],
  topics: ['Kubernetes'],
  company_research: 'Harbor builds robots.',
  interviewer_background: null,
};
const interview = (over: Partial<InterviewView> = {}): InterviewView => ({
  id: 'iv-1',
  application_id: 'app-1',
  starts_at: '2030-03-12T22:00:00.000Z',
  ends_at: '2030-03-12T23:00:00.000Z',
  confirmed: true,
  prep_plan_status: null,
  prep_plan: null,
  feedback: null,
  ...over,
});
const negotiation: NegotiationView = {
  posted_min: 210000,
  posted_max: 260000,
  currency: 'USD',
  floor: 180000,
  comparables: [
    {
      source: 'levels.fyi',
      title: 'Software Engineer',
      level: 'Staff (L6)',
      location: 'San Francisco Bay Area',
      currency: 'USD',
      p25: 310000,
      p50: 365000,
      p75: 430000,
      sample_size: 212,
      retrieved_at: '2026-11-07T10:00:00.000Z',
    },
  ],
  fetched_at: '2026-11-07T10:00:00.000Z',
  error: null,
};

const renderCard = (application: Parameters<typeof CardExtras>[0]['application']) =>
  render(
    <MemoryRouter>
      <CardExtras application={application} />
    </MemoryRouter>,
  );

describe('card extras', () => {
  it('prep panel: no plan shows a Generate button that requests the plan', async () => {
    let requested = 0;
    server.use(
      http.post('*/api/interviews/iv-1/prep-plan', () => {
        requested++;
        return HttpResponse.json({ status: 'pending', enqueued: true }, { status: 202 });
      }),
      http.get('*/api/interviews/for-application/app-1', () =>
        HttpResponse.json({
          interviews: [interview({ prep_plan_status: 'pending' })],
          negotiation: null,
        }),
      ),
    );
    renderCard({ id: 'app-1', status: 'interviewing', interviews: [interview()] });
    const panel = screen.getByRole('region', { name: 'Prep plan' });
    expect(within(panel).getByText(/no prep plan for this interview yet/)).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Generate prep plan' }));
    expect(requested).toBe(1);
    expect(await screen.findByText('Your prep plan is being prepared.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generate prep plan' })).toBeNull();
  });

  it('prep panel: a ready plan links to the plan page; a failed one offers a retry', () => {
    const { unmount } = renderCard({
      id: 'app-1',
      status: 'interviewing',
      interviews: [interview({ prep_plan_status: 'ready', prep_plan: plan })],
    });
    expect(screen.getByRole('link', { name: 'Open the prep plan' })).toHaveAttribute(
      'href',
      '/interviews/iv-1/prep',
    );
    unmount();
    renderCard({
      id: 'app-1',
      status: 'interviewing',
      interviews: [interview({ prep_plan_status: 'failed' })],
    });
    expect(screen.getByText('The prep plan could not be prepared.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('feedback form: submits notes, relayed text and a rating, then edits through PUT', async () => {
    const calls: Array<{ method: string; body: unknown }> = [];
    const saved: Feedback = {
      notes: 'Went well',
      relayed: '',
      rating: 4,
      submitted_at: '2026-11-07T10:00:00.000Z',
      updated_at: '2026-11-07T10:00:00.000Z',
    };
    server.use(
      http.post('*/api/interviews/iv-1/feedback', async ({ request }) => {
        calls.push({ method: 'POST', body: await request.json() });
        return HttpResponse.json({ feedback: saved }, { status: 201 });
      }),
      http.put('*/api/interviews/iv-1/feedback', async ({ request }) => {
        calls.push({ method: 'PUT', body: await request.json() });
        return HttpResponse.json({
          feedback: { ...saved, notes: 'Edited', updated_at: '2026-11-08T10:00:00.000Z' },
        });
      }),
      http.get('*/api/interviews/for-application/app-1', () =>
        HttpResponse.json({ interviews: [interview({ feedback: saved })], negotiation: null }),
      ),
    );
    renderCard({ id: 'app-1', status: 'interviewing', interviews: [interview()] });
    const form = screen.getByRole('form', { name: 'Interview feedback' });
    await userEvent.type(within(form).getByLabelText('Your notes'), 'Went well');
    await userEvent.selectOptions(within(form).getByLabelText(/Overall rating/), '4');
    await userEvent.click(within(form).getByRole('button', { name: 'Submit feedback' }));
    expect(await within(form).findByText('Saved.')).toBeInTheDocument();
    expect(calls[0]).toEqual({
      method: 'POST',
      body: { notes: 'Went well', relayed: '', rating: 4 },
    });

    const notes = within(form).getByLabelText('Your notes');
    await userEvent.clear(notes);
    await userEvent.type(notes, 'Edited');
    await userEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toMatchObject({ method: 'PUT', body: { notes: 'Edited' } });
  });

  it('feedback form: shows the message when the server refuses an empty submission', async () => {
    server.use(
      http.post('*/api/interviews/iv-1/feedback', () =>
        HttpResponse.json(
          {
            code: 'empty_feedback',
            message: 'Add your own notes or the feedback the interviewer shared before saving.',
          },
          { status: 400 },
        ),
      ),
    );
    renderCard({ id: 'app-1', status: 'interviewing', interviews: [interview()] });
    await userEvent.click(screen.getByRole('button', { name: 'Submit feedback' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Add your own notes');
  });

  it('offer panel: posted range, comparables with source and date, and the floor', () => {
    renderCard({ id: 'app-1', status: 'offer', interviews: [], negotiation });
    const panel = screen.getByRole('region', { name: 'Offer' });
    expect(within(panel).getByText('$210,000 to $260,000')).toBeInTheDocument();
    expect(within(panel).getByText('$180,000')).toBeInTheDocument();
    expect(within(panel).getByText('$365,000')).toBeInTheDocument();
    expect(within(panel).getByText(/levels\.fyi/)).toBeInTheDocument();
    expect(within(panel).getByText(/retrieved/)).toBeInTheDocument();
  });

  it('offer panel: no comparables says so and still shows the range and floor', () => {
    renderCard({
      id: 'app-1',
      status: 'offer',
      interviews: [],
      negotiation: { ...negotiation, comparables: [], error: 'no_data' },
    });
    expect(screen.getByText(/No comparable pay data was found/)).toBeInTheDocument();
    expect(screen.getByText('$210,000 to $260,000')).toBeInTheDocument();
    expect(screen.getByText('$180,000')).toBeInTheDocument();
  });

  it('offer panel: no data yet offers to gather it', async () => {
    let asked = 0;
    server.use(
      http.post('*/api/interviews/for-application/app-1/negotiation', () => {
        asked++;
        return HttpResponse.json({ status: 'queued', enqueued: true }, { status: 202 });
      }),
      http.get('*/api/interviews/for-application/app-1', () =>
        HttpResponse.json({ interviews: [], negotiation: null }),
      ),
    );
    renderCard({ id: 'app-1', status: 'offer', interviews: [], negotiation: null });
    await userEvent.click(screen.getByRole('button', { name: 'Gather pay data' }));
    expect(asked).toBe(1);
    expect(await screen.findByText(/We are gathering pay data/)).toBeInTheDocument();
  });

  it('loads the interviews itself when the card gives none, and says so when there are none', async () => {
    server.use(
      http.get('*/api/interviews/for-application/app-1', () =>
        HttpResponse.json({ interviews: [], negotiation: null }),
      ),
    );
    renderCard({ id: 'app-1', status: 'applied' });
    expect(await screen.findByText(/No interview is booked yet/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Offer' })).toBeNull();
  });
});

describe('deep links', () => {
  it('the feedback link opens the form for that interview', async () => {
    server.use(
      http.get('*/api/interviews/iv-1', () => HttpResponse.json({ interview: interview() })),
    );
    render(
      <MemoryRouter initialEntries={['/interviews/iv-1/feedback']}>
        <Routes>
          <Route path="/interviews/:id/feedback" element={<FeedbackPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('form', { name: 'Interview feedback' })).toBeInTheDocument();
  });

  it('the prep link shows the four sections of a ready plan', async () => {
    server.use(
      http.get('*/api/interviews/iv-1', () =>
        HttpResponse.json({ interview: interview({ prep_plan_status: 'ready', prep_plan: plan }) }),
      ),
    );
    render(
      <MemoryRouter initialEntries={['/interviews/iv-1/prep']}>
        <Routes>
          <Route path="/interviews/:id/prep" element={<PrepPlanPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Tell us about scaling.')).toBeInTheDocument();
    expect(screen.getByText('Kubernetes')).toBeInTheDocument();
    expect(screen.getByText('Harbor builds robots.')).toBeInTheDocument();
    expect(screen.getByText('No interviewer information was found.')).toBeInTheDocument();
  });
});
