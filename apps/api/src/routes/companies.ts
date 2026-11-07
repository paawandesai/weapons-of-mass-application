import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../middleware/session';
import { isUuid } from '../services/uuid';
import {
  addCompany,
  CompanyAddError,
  defaultResolver,
  listCompanyViews,
  removeCompany,
  type BoardResolver,
} from '../services/discovery';
import { invalidJson, readJson, validationError } from '../services/http';

const AddBody = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    board_url: z.string().trim().min(1).max(500).optional(),
  })
  .refine((b) => (b.name === undefined) !== (b.board_url === undefined), {
    message: 'provide either name or board_url',
  });

export interface CompaniesDeps {
  resolve?: BoardResolver;
}

export function createCompaniesRoutes(deps: CompaniesDeps = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const { handle, userId } = c.get('session');
    return c.json({ companies: await listCompanyViews(handle, userId) });
  });

  app.post('/', async (c) => {
    const { handle, userId } = c.get('session');
    const raw = await readJson(c);
    if (raw === undefined) return invalidJson(c);
    const parsed = AddBody.safeParse(raw);
    if (!parsed.success) return validationError(c, parsed.error);
    try {
      const { companies, added } = await addCompany(
        handle,
        userId,
        parsed.data,
        deps.resolve ?? defaultResolver,
      );
      return c.json({ companies }, added ? 201 : 200);
    } catch (e) {
      if (e instanceof CompanyAddError)
        return c.json({ code: e.code, message: e.message }, e.status);
      throw e;
    }
  });

  app.delete('/:id', async (c) => {
    const { handle, userId } = c.get('session');
    const id = c.req.param('id');
    if (!isUuid(id) || !(await removeCompany(handle, userId, id))) {
      return c.json({ code: 'not_found', message: 'That company is not on your list.' }, 404);
    }
    return c.json({ id, removed: true });
  });

  return app;
}

export const companiesRoutes = createCompaniesRoutes();
