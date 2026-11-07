import type { ProfileFlag } from '@wma/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { formatTime } from '../src/api';
import { App } from '../src/App';
import { ProfileReviewPage } from '../src/pages/ProfileReviewPage';
import { conn, fixtureDocument, NOW, state } from './server';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

const flag: ProfileFlag = {
  id: 'fl1',
  kind: 'date_conflict',
  path: 'work_history.0.start_date',
  message: 'Start date differs between resume and LinkedIn',
  sources: ['resume', 'linkedin'],
  resolved: false,
};

function seedProfile(flags: ProfileFlag[] = []) {
  const document = fixtureDocument();
  document.flags = flags;
  state.profile = { version: 1, document, approved_version: null, approved_at: null };
}

describe('sign in', () => {
  it('shows one sign-in link and an error banner from the query string', async () => {
    renderAt('/signin?error=unverified_email');
    expect(screen.getByRole('link', { name: 'Sign in with Google' })).toHaveAttribute(
      'href',
      '/auth/google/start',
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/not verified/i);
  });

  it('shows no banner without an error', () => {
    renderAt('/signin');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('sends an unauthenticated visitor to sign in', async () => {
    state.authed = false;
    renderAt('/connections');
    expect(await screen.findByRole('link', { name: 'Sign in with Google' })).toBeInTheDocument();
  });
});

describe('dashboard', () => {
  it('shows onboarding progress', async () => {
    renderAt('/');
    const list = await screen.findByRole('list', { name: 'Onboarding progress' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent('Done');
    expect(items[1]).toHaveTextContent('Resume uploaded');
    expect(items[1]).toHaveTextContent('Done');
    expect(items[2]).toHaveTextContent('To do');
    expect(items[3]).toHaveTextContent('To do');
  });
});

describe('connections', () => {
  it('shows Drive as missing when the scope is absent', async () => {
    state.connections = state.connections.map((c) =>
      c.kind === 'drive' ? conn('drive', 'disconnected') : c,
    );
    renderAt('/connections');
    const drive = await screen.findByTestId('google-drive');
    expect(drive).toHaveTextContent('Missing');
    expect(screen.getByTestId('google-gmail')).toHaveTextContent('Connected');
    expect(screen.getByRole('link', { name: 'Reconnect with Google' })).toHaveAttribute(
      'href',
      '/auth/google/start?reconnect=1',
    );
    expect(screen.getByText(/Drive access is missing/)).toBeInTheDocument();
  });

  it('rejects a PNG resume on the client with a message', async () => {
    const user = userEvent.setup({ applyAccept: false });
    renderAt('/connections');
    const input = await screen.findByLabelText('Resume file');
    await user.upload(input, new File(['x'], 'photo.png', { type: 'image/png' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/PDF or DOCX/);
    expect(screen.queryByText('Resume uploaded.')).toBeNull();
  });

  it('accepts a PDF resume', async () => {
    const user = userEvent.setup();
    renderAt('/connections');
    const input = await screen.findByLabelText('Resume file');
    await user.upload(input, new File(['%PDF'], 'cv.pdf', { type: 'application/pdf' }));
    expect(await screen.findByText('Resume uploaded.')).toBeInTheDocument();
  });

  it('saves GitHub and LinkedIn, validating input', async () => {
    const user = userEvent.setup();
    renderAt('/connections');
    await screen.findByText('Profile sources');
    await user.type(screen.getByLabelText('GitHub username'), 'ada-l');
    await user.click(screen.getByRole('button', { name: 'Save GitHub' }));
    expect(await screen.findByText('GitHub saved.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Public profile URL'), 'not a url');
    await user.click(screen.getByRole('button', { name: 'Save LinkedIn' }));
    expect(await screen.findByText(/full profile URL/)).toBeInTheDocument();
  });

  it('lists Drive folders and saves the selection', async () => {
    const user = userEvent.setup();
    renderAt('/connections');
    await user.click(await screen.findByRole('button', { name: 'Choose folders' }));
    await user.click(await screen.findByLabelText('Career'));
    await user.click(screen.getByRole('button', { name: 'Save folders' }));
    expect(await screen.findByText('Drive folders saved.')).toBeInTheDocument();
    expect(state.connections.find((c) => c.kind === 'drive')?.config).toEqual({
      folder_ids: ['f1'],
    });
  });

  it('asks for confirmation before disconnecting', async () => {
    const user = userEvent.setup();
    renderAt('/connections');
    const card = (await screen.findByLabelText('Resume', { selector: 'div' })) as HTMLElement;
    await user.click(within(card).getByRole('button', { name: 'Disconnect' }));
    await user.click(within(card).getByRole('button', { name: 'Cancel' }));
    expect(state.connections.find((c) => c.kind === 'resume')?.status).toBe('connected');
    await user.click(within(card).getByRole('button', { name: 'Disconnect' }));
    await user.click(within(card).getByRole('button', { name: 'Yes, disconnect' }));
    expect(await screen.findByText('resume disconnected.')).toBeInTheDocument();
    expect(state.connections.find((c) => c.kind === 'resume')?.status).toBe('disconnected');
  });
});

describe('survey', () => {
  it('defaults the daily target to 12', async () => {
    renderAt('/survey');
    expect(await screen.findByLabelText(/Applications per day/)).toHaveValue(12);
  });

  it('highlights missing required fields and keeps entered answers', async () => {
    const user = userEvent.setup();
    renderAt('/survey');
    await user.type(await screen.findByLabelText(/Work-life balance/), 'Evenings free');
    await user.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(await screen.findByText('Enter at least one target role.')).toBeInTheDocument();
    expect(screen.getByText('Enter your minimum salary.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Work-life balance/)).toHaveValue('Evenings free');
    expect(state.survey).toBeNull();
  });

  it('rejects an out-of-range target and shows the range', async () => {
    const user = userEvent.setup();
    renderAt('/survey');
    await user.type(await screen.findByLabelText(/Target roles/), 'Engineer');
    await user.type(screen.getByLabelText(/Salary floor/), '100000');
    const target = screen.getByLabelText(/Applications per day/);
    for (const bad of ['0', '31']) {
      await user.clear(target);
      await user.type(target, bad);
      await user.click(screen.getByRole('button', { name: 'Save and continue' }));
      expect(await screen.findByText(/from 1 to 30/)).toBeInTheDocument();
    }
    expect(state.survey).toBeNull();
  });

  it('stores target 12 when left blank and proceeds to review', async () => {
    const user = userEvent.setup();
    seedProfile();
    renderAt('/survey');
    await user.type(await screen.findByLabelText(/Target roles/), 'Engineer, Manager');
    await user.type(screen.getByLabelText(/Salary floor/), '120000');
    await user.clear(screen.getByLabelText(/Applications per day/));
    await user.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(await screen.findByRole('heading', { name: 'Profile review' })).toBeInTheDocument();
    expect(state.survey).toMatchObject({
      target_roles: ['Engineer', 'Manager'],
      salary_floor: 120000,
      daily_target: 12,
    });
  });
});

describe('profile review', () => {
  it('disables Approve with an unresolved flag and enables it after resolving', async () => {
    const user = userEvent.setup();
    seedProfile([flag]);
    renderAt('/profile/review');
    const approve = await screen.findByRole('button', { name: 'Approve' });
    expect(approve).toBeDisabled();

    const resolve = screen.getByRole('button', { name: /Resolve: Start date differs/ });
    expect(resolve).toBeDisabled();
    const start = screen.getByLabelText('Start (YYYY-MM or YYYY)', {
      selector: '#f-work_history\\.0\\.start_date',
    });
    await user.clear(start);
    await user.type(start, '2019-05');
    expect(resolve).toBeEnabled();
    await user.click(resolve);

    expect(screen.getByText('Nothing needs your attention.')).toBeInTheDocument();
    expect(approve).toBeEnabled();
  });

  it('does not block Approve for partial_source flags and approves the displayed version', async () => {
    const user = userEvent.setup();
    seedProfile([
      {
        id: 'p1',
        kind: 'partial_source',
        path: null,
        message: 'LinkedIn returned no text',
        sources: ['linkedin'],
        resolved: false,
      },
    ]);
    state.profile!.version = 4;
    renderAt('/profile/review');
    const approve = await screen.findByRole('button', { name: 'Approve' });
    expect(approve).toBeEnabled();
    await user.click(approve);
    expect(await screen.findByLabelText('Approval status')).toHaveTextContent('Approved');
    expect(state.approvedVersions).toEqual([4]);
    expect(state.saved).toHaveLength(0);
  });

  it('approves the version it just saved when there were edits', async () => {
    const user = userEvent.setup();
    seedProfile();
    renderAt('/profile/review');
    const headline = await screen.findByLabelText('Headline');
    await user.clear(headline);
    await user.type(headline, 'Principal engineer');
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByLabelText('Approval status');
    expect(state.approvedVersions).toEqual([2]);
  });

  it('reloads and explains when a newer version arrived before Approve', async () => {
    const user = userEvent.setup();
    seedProfile();
    renderAt('/profile/review');
    const approve = await screen.findByRole('button', { name: 'Approve' });
    // A rebuild finished on the server after this page loaded version 1.
    state.profile!.version = 2;
    await user.click(approve);
    expect(await screen.findByRole('alert')).toHaveTextContent(/newer version of your profile/);
    expect(await screen.findByText('Version 2')).toBeInTheDocument();
    expect(state.profile?.approved_version).toBeNull();
    // Approving again sends the version now on screen.
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByLabelText('Approval status');
    expect(state.approvedVersions).toEqual([1, 2]);
  });

  it('keeps Approve disabled while a rebuild is running', async () => {
    const user = userEvent.setup();
    seedProfile();
    state.buildStatuses = [
      { state: 'running' },
      { state: 'running' },
      { state: 'done', version: 2 },
    ];
    render(
      <MemoryRouter>
        <ProfileReviewPage pollMs={30} />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Rebuild from sources' }));
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(await screen.findByText(/profile was rebuilt/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled());
  });

  describe('date conflicts name both entries', () => {
    const conflict: ProfileFlag = {
      id: 'dc1',
      kind: 'date_conflict',
      path: 'work_history.0',
      paths: ['work_history.0', 'work_history.1'],
      message: 'Acme: two titles overlap',
      sources: ['resume', 'linkedin'],
      resolved: false,
    };
    const seedConflict = () => {
      seedProfile([conflict]);
      const doc = state.profile!.document;
      doc.work_history.push({
        ...doc.work_history[0]!,
        title: 'Senior Programmer',
        sources: ['linkedin'],
      });
    };

    it('enables Resolve after the second entry is removed, even once saved', async () => {
      const user = userEvent.setup();
      seedConflict();
      renderAt('/profile/review');
      const resolve = await screen.findByRole('button', { name: /Resolve: Acme: two titles/ });
      expect(resolve).toBeDisabled();
      const removeButtons = screen.getAllByRole('button', { name: 'Remove entry' });
      await user.click(removeButtons[1]!);
      expect(resolve).toBeEnabled();
      // Saving keeps the flag; it must stay resolvable afterwards.
      await user.click(screen.getByRole('button', { name: 'Save as new version' }));
      await screen.findByText('Saved as a new version.');
      expect(screen.getByRole('button', { name: /Resolve: Acme: two titles/ })).toBeEnabled();
      await user.click(screen.getByRole('button', { name: /Resolve: Acme: two titles/ }));
      expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
    });

    it('enables Resolve when only the second entry is edited', async () => {
      const user = userEvent.setup();
      seedConflict();
      renderAt('/profile/review');
      const resolve = await screen.findByRole('button', { name: /Resolve: Acme: two titles/ });
      expect(resolve).toBeDisabled();
      const title = screen.getByLabelText('Title', { selector: '#f-work_history\\.1\\.title' });
      await user.type(title, ' II');
      expect(resolve).toBeEnabled();
    });
  });

  it('saves edits as a new version and approves, showing the approval time', async () => {
    const user = userEvent.setup();
    seedProfile([flag]);
    renderAt('/profile/review');
    const start = await screen.findByLabelText('Start (YYYY-MM or YYYY)', {
      selector: '#f-work_history\\.0\\.start_date',
    });
    await user.clear(start);
    await user.type(start, '2019-05');
    await user.click(screen.getByRole('button', { name: /Resolve: Start date differs/ }));
    await user.click(screen.getByRole('button', { name: 'Approve' }));

    const status = await screen.findByLabelText('Approval status');
    expect(status).toHaveTextContent(`Approved ${formatTime(NOW)}`);
    expect(state.saved).toHaveLength(1);
    expect(state.approveCalls).toBe(1);
    expect(state.profile?.document.work_history[0]?.start_date).toBe('2019-05');
    expect(state.profile?.document.flags).toEqual([]);
  });

  it('blocks saving invalid fields with a message', async () => {
    const user = userEvent.setup();
    seedProfile();
    renderAt('/profile/review');
    const email = await screen.findByLabelText('Email');
    await user.clear(email);
    await user.type(email, 'nope');
    await user.click(screen.getByRole('button', { name: 'Save as new version' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/contact\.email/);
    expect(state.saved).toHaveLength(0);
  });

  it('rebuilds by calling build and polling status until done', async () => {
    const user = userEvent.setup();
    seedProfile();
    state.buildStatuses = [{ state: 'running' }, { state: 'done', version: 2 }];
    render(
      <MemoryRouter>
        <ProfileReviewPage pollMs={10} />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Rebuild from sources' }));
    expect(await screen.findByText(/profile was rebuilt/)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Rebuild from sources' })).toBeEnabled(),
    );
  });

  it('explains a rebuild refused for lack of a resume', async () => {
    const user = userEvent.setup();
    seedProfile();
    state.hasResume = false;
    render(
      <MemoryRouter>
        <ProfileReviewPage pollMs={10} />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Rebuild from sources' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Upload a resume/);
  });

  it('offers a build when no profile exists', async () => {
    renderAt('/profile/review');
    expect(await screen.findByText(/No profile has been built yet/)).toBeInTheDocument();
  });
});
