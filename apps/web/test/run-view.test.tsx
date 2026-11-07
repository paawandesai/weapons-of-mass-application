import { act, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentRun, RunCandidateView, RunSummary } from '../src/api';
import { RUN_POLL_MS, RunViewPage } from '../src/pages/RunViewPage';
import { server } from './server';

const run = (over: Partial<RunSummary> = {}): RunSummary => ({
  id: 'run-1',
  date: '2026-11-07',
  trigger: 'manual',
  status: 'running',
  step: 'judge',
  target: 12,
  started_at: '2026-11-07T10:00:00.000Z',
  ended_at: null,
  counts: { judged: 1, approved: 1, selected: 0 },
  short_day: false,
  shortfall: 0,
  error: null,
  ...over,
});
const cand = (title: string, over: Partial<RunCandidateView> = {}): RunCandidateView => ({
  rank: 1,
  title,
  company: 'Harbor Robotics',
  url: `https://jobs.example.test/${title}`,
  apply: true,
  rationale: `reason for ${title}`,
  selected: false,
  exclusion_reason: null,
  ...over,
});
const page = (over: Partial<CurrentRun>): CurrentRun => ({
  run: run(),
  candidates: [],
  next_cursor: null,
  has_more: false,
  next_run_at: null,
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('run view', () => {
  it('shows the empty state with the next scheduled run for a user without runs', async () => {
    server.use(
      http.get('*/api/runs/current', () =>
        HttpResponse.json(page({ run: null, next_run_at: '2026-11-08T08:00:00.000Z' })),
      ),
    );
    render(<RunViewPage />);
    expect(await screen.findByText('No run has happened yet.')).toBeInTheDocument();
    expect(screen.getByText(/Your next run is scheduled for/)).toBeInTheDocument();
  });

  it('polls every five seconds while the run is running and appends new rows after the cursor', async () => {
    const seen: Array<string | null> = [];
    const replies: CurrentRun[] = [
      page({ candidates: [cand('Alpha')], next_cursor: 'c1' }),
      page({
        candidates: [cand('Beta', { rank: 2, apply: false, rationale: 'too junior' })],
        next_cursor: 'c2',
      }),
      page({
        run: run({ status: 'finished', counts: { judged: 2, approved: 1, selected: 1 } }),
        candidates: [],
        next_cursor: 'c2',
      }),
    ];
    server.use(
      http.get('*/api/runs/current', ({ request }) => {
        seen.push(new URL(request.url).searchParams.get('cursor'));
        return HttpResponse.json(replies[Math.min(seen.length - 1, replies.length - 1)]);
      }),
    );
    render(<RunViewPage />);
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('reason for Alpha')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUN_POLL_MS);
    });
    expect(await screen.findByText('Beta')).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('too junior')).toBeInTheDocument();
    expect(screen.getByText(/Skip/)).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUN_POLL_MS);
    });
    await waitFor(() => expect(screen.getByText('Finished')).toBeInTheDocument());
    expect(seen).toEqual([null, 'c1', 'c2']);

    // finished: no more polling
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUN_POLL_MS * 3);
    });
    expect(seen).toHaveLength(3);
  });

  it('never overlaps polls: a slow response delays the next poll and rows are not duplicated', async () => {
    let calls = 0;
    const seen: Array<string | null> = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    server.use(
      http.get('*/api/runs/current', async ({ request }) => {
        calls++;
        seen.push(new URL(request.url).searchParams.get('cursor'));
        if (calls === 1)
          return HttpResponse.json(page({ candidates: [cand('Alpha')], next_cursor: 'c1' }));
        if (calls === 2) {
          await gate;
          return HttpResponse.json(
            page({ candidates: [cand('Beta', { rank: 2 })], next_cursor: 'c2' }),
          );
        }
        return HttpResponse.json(
          page({ run: run({ status: 'finished' }), candidates: [], next_cursor: 'c2' }),
        );
      }),
    );
    render(<RunViewPage />);
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUN_POLL_MS);
    });
    // the second request is still in flight for three more intervals: no third request starts
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUN_POLL_MS * 3);
    });
    expect(calls).toBe(2);
    release();
    expect(await screen.findByText('Beta')).toBeInTheDocument();
    expect(screen.getAllByText('Alpha')).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUN_POLL_MS);
    });
    await waitFor(() => expect(screen.getByText('Finished')).toBeInTheDocument());
    expect(seen).toEqual([null, 'c1', 'c2']);
  });

  it('does not poll a finished run', async () => {
    let calls = 0;
    server.use(
      http.get('*/api/runs/current', () => {
        calls++;
        return HttpResponse.json(
          page({
            run: run({ status: 'finished', counts: { judged: 1, approved: 1, selected: 1 } }),
            candidates: [cand('Gamma', { selected: true })],
          }),
        );
      }),
    );
    render(<RunViewPage />);
    expect(await screen.findByText('Gamma')).toBeInTheDocument();
    expect(screen.getByText('Selected to apply')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUN_POLL_MS * 2);
    });
    expect(calls).toBe(1);
  });

  it('shows the reason a posting was not applied to', async () => {
    server.use(
      http.get('*/api/runs/current', () =>
        HttpResponse.json(
          page({
            run: run({ status: 'short_day' }),
            candidates: [cand('Delta', { exclusion_reason: 'over_target' })],
          }),
        ),
      ),
    );
    render(<RunViewPage />);
    expect(await screen.findByText(/Over the daily limit/)).toBeInTheDocument();
  });

  it('shows an error banner when the run cannot be loaded', async () => {
    server.use(
      http.get('*/api/runs/current', () =>
        HttpResponse.json({ code: 'internal', message: 'Something went wrong' }, { status: 500 }),
      ),
    );
    render(<RunViewPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
  });
});
