import type { ProfileDocument } from '@wma/shared';

/** Everything here is fictional: no real person, employer or contact detail. */
export const DEMO_TENANT_SLUG = 'demo';
export const DEMO_USER_EMAIL = 'demo@wma.local';
export const DEFAULT_DEMO_FORMS_PORT = 4310;
/** The default origin of the saved ATS forms the worker serves in demo mode. */
export const DEMO_FORMS_ORIGIN = `http://127.0.0.1:${DEFAULT_DEMO_FORMS_PORT}`;

/**
 * Where the forms are served: `DEMO_FORMS_ORIGIN` if set, else `http://127.0.0.1:<DEMO_FORMS_PORT>`
 * (default 4310). The seed, the worker's adapter routing and the rehearsal all read this one rule.
 */
export function demoFormsOrigin(env: Record<string, string | undefined> = process.env): string {
  const origin = env.DEMO_FORMS_ORIGIN?.trim();
  if (origin) return origin.replace(/\/+$/, '');
  const port = env.DEMO_FORMS_PORT?.trim();
  return `http://127.0.0.1:${port || DEFAULT_DEMO_FORMS_PORT}`;
}

export type DemoVendor = 'greenhouse' | 'lever' | 'ashby';

export interface DemoPosting {
  company: string;
  /** Board slug; also the company part of the simulated recruiter's address. */
  slug: string;
  vendor: DemoVendor;
  title: string;
  location: string;
  mode: 'remote' | 'hybrid' | 'onsite';
  payMin: number;
  payMax: number;
  description: string;
  /** The posting serves the CAPTCHA variant of the form (`?captcha`). */
  captcha?: boolean;
}

/** Twelve postings across the three form shapes, one with a CAPTCHA. */
export const DEMO_POSTINGS: DemoPosting[] = [
  {
    company: 'Harbor Robotics',
    slug: 'harbor-robotics',
    vendor: 'greenhouse',
    title: 'Staff Platform Engineer',
    location: 'San Francisco, CA',
    mode: 'hybrid',
    payMin: 220000,
    payMax: 280000,
    description: 'Own the fleet telemetry platform that every warehouse robot reports to.',
  },
  {
    company: 'Lumen Labs',
    slug: 'lumen-labs',
    vendor: 'greenhouse',
    title: 'Senior Backend Engineer',
    location: 'Remote (US)',
    mode: 'remote',
    payMin: 190000,
    payMax: 240000,
    description: 'Build the ingestion services behind a sensor analytics product.',
    captcha: true,
  },
  {
    company: 'Northwind Grid',
    slug: 'northwind-grid',
    vendor: 'greenhouse',
    title: 'Senior Software Engineer, Data Pipelines',
    location: 'Oakland, CA',
    mode: 'hybrid',
    payMin: 185000,
    payMax: 235000,
    description: 'Move energy-market batch jobs to a streaming architecture.',
  },
  {
    company: 'Cedar Health',
    slug: 'cedar-health',
    vendor: 'greenhouse',
    title: 'Staff Software Engineer, Scheduling',
    location: 'Remote (US)',
    mode: 'remote',
    payMin: 210000,
    payMax: 265000,
    description: 'Design the appointment scheduling core for a clinic network.',
  },
  {
    company: 'Quarry Systems',
    slug: 'quarry-systems',
    vendor: 'lever',
    title: 'Principal Engineer, Developer Tools',
    location: 'San Jose, CA',
    mode: 'hybrid',
    payMin: 240000,
    payMax: 300000,
    description: 'Lead the build and test infrastructure used by every engineering team.',
  },
  {
    company: 'Tidewater Pay',
    slug: 'tidewater-pay',
    vendor: 'lever',
    title: 'Senior Engineer, Payments Reliability',
    location: 'San Francisco, CA',
    mode: 'onsite',
    payMin: 200000,
    payMax: 250000,
    description: 'Keep a card-processing platform correct under load.',
  },
  {
    company: 'Fernhill Media',
    slug: 'fernhill-media',
    vendor: 'lever',
    title: 'Staff Backend Engineer, Streaming',
    location: 'Remote (US)',
    mode: 'remote',
    payMin: 205000,
    payMax: 260000,
    description: 'Scale the playback and recommendations services for a video platform.',
  },
  {
    company: 'Brightwave Energy',
    slug: 'brightwave-energy',
    vendor: 'lever',
    title: 'Senior Software Engineer, Grid Software',
    location: 'Palo Alto, CA',
    mode: 'hybrid',
    payMin: 195000,
    payMax: 245000,
    description: 'Write the control software for distributed battery storage.',
  },
  {
    company: 'Saffron Cloud',
    slug: 'saffron-cloud',
    vendor: 'ashby',
    title: 'Staff Engineer, Infrastructure',
    location: 'San Francisco, CA',
    mode: 'hybrid',
    payMin: 230000,
    payMax: 290000,
    description: 'Run the multi-region compute layer for a developer cloud.',
  },
  {
    company: 'Pinecrest Labs',
    slug: 'pinecrest-labs',
    vendor: 'ashby',
    title: 'Senior Full-Stack Engineer',
    location: 'Remote (US)',
    mode: 'remote',
    payMin: 175000,
    payMax: 225000,
    description: 'Ship customer-facing workflows end to end on a small product team.',
  },
  {
    company: 'Copperline Security',
    slug: 'copperline-security',
    vendor: 'ashby',
    title: 'Senior Engineer, Detection Platform',
    location: 'Mountain View, CA',
    mode: 'hybrid',
    payMin: 205000,
    payMax: 255000,
    description: 'Build the event pipeline behind a threat-detection product.',
  },
  {
    company: 'Marlow Logistics',
    slug: 'marlow-logistics',
    vendor: 'ashby',
    title: 'Staff Software Engineer, Routing',
    location: 'Remote (US)',
    mode: 'remote',
    payMin: 215000,
    payMax: 270000,
    description: 'Improve the route-planning service that dispatches a delivery fleet.',
  },
];

/** `<origin>/forms/<vendor>/<job slug>` with `?captcha` for the challenge variant. */
export function postingUrl(p: DemoPosting, origin: string = DEMO_FORMS_ORIGIN): string {
  const slug = `${p.slug}-${p.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}`;
  return `${origin}/forms/${p.vendor}/${slug}${p.captcha ? '?captcha' : ''}`;
}

export function postingJobId(p: DemoPosting): string {
  return postingUrl(p, DEMO_FORMS_ORIGIN).split('/').pop()!.split('?')[0]!;
}

/** The fictional approved profile of the demo user. */
export const DEMO_PROFILE: ProfileDocument = {
  identity: {
    full_name: 'Jordan Avery',
    headline: 'Staff software engineer, platform and data systems',
    location: 'Oakland, CA',
    summary:
      'Staff engineer with a decade of experience building reliable data platforms and developer tooling. Open to remote and Bay Area hybrid roles.',
  },
  contact: {
    email: 'demo@wma.local',
    phone: '+1 555 010 0199',
    linkedin_url: 'https://www.linkedin.com/in/jordan-avery-demo',
    github_url: 'https://github.com/jordan-avery-demo',
    website_url: null,
  },
  work_history: [
    {
      employer: 'Meridian Freight',
      title: 'Staff Software Engineer',
      location: 'San Francisco, CA',
      start_date: '2021-02',
      end_date: null,
      summary: 'Leads the shipment-events platform used by every internal product.',
      highlights: [
        'Replaced nightly batch reconciliation with a streaming pipeline, cutting delay from hours to seconds',
        'Led a team of six across two time zones',
      ],
      sources: ['resume:1', 'linkedin'],
    },
    {
      employer: 'Bluepoint Analytics',
      title: 'Senior Software Engineer',
      location: 'Oakland, CA',
      start_date: '2017-06',
      end_date: '2021-01',
      summary: 'Built the query and ingestion services of a product analytics tool.',
      highlights: ['Cut p99 query latency by 45 percent', 'Mentored four engineers to promotion'],
      sources: ['resume:1'],
    },
  ],
  projects: [
    {
      name: 'pgqueue-lite',
      description: 'A small Postgres-backed job queue with exactly-once handoff.',
      url: 'https://github.com/jordan-avery-demo/pgqueue-lite',
      technologies: ['TypeScript', 'PostgreSQL'],
      start_date: '2022-03',
      end_date: null,
      sources: ['github'],
    },
  ],
  skills: [
    { name: 'TypeScript', category: 'language' },
    { name: 'Go', category: 'language' },
    { name: 'PostgreSQL', category: 'database' },
    { name: 'Kafka', category: 'infrastructure' },
    { name: 'Mentoring', category: null },
  ],
  education: [
    {
      institution: 'State University',
      degree: 'BS',
      field: 'Computer Science',
      start_date: '2009-09',
      end_date: '2013-06',
      sources: ['resume:1'],
    },
  ],
  preferences: {
    target_titles: ['Staff Software Engineer', 'Senior Software Engineer', 'Principal Engineer'],
    locations: ['San Francisco Bay Area', 'Remote (US)'],
    remote: 'remote',
  },
  survey: {
    target_roles: ['Staff Software Engineer', 'Senior Software Engineer'],
    salary_floor: 190000,
    work_life_balance: 'No weekend on-call',
    family_constraints: null,
    willing_to_relocate: false,
    career_direction: 'Platform and developer-tooling leadership',
    daily_target: 8,
  },
  standard_answers: {
    work_authorization: 'Authorized to work in the United States',
    visa_sponsorship_required: false,
    start_date: 'Within 30 days',
    earliest_start_date: '2026-12-01',
    previous_interviews: [],
    notice_period: '2 weeks',
    reasons_for_change: 'Looking for broader platform ownership',
  },
  flags: [],
};
