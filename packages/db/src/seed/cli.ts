import { DEFAULT_DATABASE_URL, loadEnv } from '../env';
import { seedDemo } from './demo';

loadEnv();
const url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const scenarios = process.argv.includes('--scenarios');
const summary = await seedDemo(url, { log: () => {}, scenarios });
console.log(
  `${summary.created ? 'created' : 'found'} demo tenant ${summary.tenantId} (slug ${summary.slug}), user ${summary.userId}`,
);
console.log(JSON.stringify(summary.counts));
if (summary.scenarios) console.log(`scenarios ${JSON.stringify(summary.scenarios)}`);
