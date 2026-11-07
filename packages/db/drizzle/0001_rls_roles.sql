-- Application role, row-level security, grants. Runs as the owner role.
-- The migration runner passes the app role password as session setting wma.app_password
-- (from APP_DB_PASSWORD); it falls back to 'wma_app'.
DO $$
DECLARE pw text := coalesce(nullif(current_setting('wma.app_password', true), ''), 'wma_app');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wma_app') THEN
    EXECUTE format('CREATE ROLE wma_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L', pw);
  ELSE
    EXECUTE format('ALTER ROLE wma_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD %L', pw);
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO wma_app', current_database());
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO wma_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wma_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wma_app;--> statement-breakpoint
-- The activity log is append-only for the application role.
REVOKE UPDATE, DELETE, TRUNCATE ON activity_log FROM wma_app;--> statement-breakpoint
DO $$
DECLARE t text;
DECLARE cmd text;
DECLARE col text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenants','users','sessions','source_connections','profiles','activity_log','vault_keys','secrets'] LOOP
    col := CASE WHEN t = 'tenants' THEN 'id' ELSE 'tenant_id' END;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_select ON %I FOR SELECT USING (%I = current_setting(''app.tenant_id'')::uuid)', t, col);
    EXECUTE format('CREATE POLICY tenant_insert ON %I FOR INSERT WITH CHECK (%I = current_setting(''app.tenant_id'')::uuid)', t, col);
    EXECUTE format('CREATE POLICY tenant_update ON %I FOR UPDATE USING (%I = current_setting(''app.tenant_id'')::uuid) WITH CHECK (%I = current_setting(''app.tenant_id'')::uuid)', t, col, col);
    EXECUTE format('CREATE POLICY tenant_delete ON %I FOR DELETE USING (%I = current_setting(''app.tenant_id'')::uuid)', t, col);
  END LOOP;
END $$;--> statement-breakpoint
-- Pre-tenant lookups: a session id or Google identity must be resolved to a tenant before a
-- handle exists. These two functions are the only RLS bypass; they run as the owner (which must
-- be a superuser or BYPASSRLS role) and return identifiers only.
CREATE FUNCTION wma_resolve_session(p_id text)
RETURNS TABLE (tenant_id uuid, user_id uuid, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT s.tenant_id, s.user_id, s.expires_at FROM public.sessions s WHERE s.id = p_id $$;--> statement-breakpoint
CREATE FUNCTION wma_find_user_identity(p_google_sub text, p_email text)
RETURNS TABLE (tenant_id uuid, user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT u.tenant_id, u.id FROM public.users u WHERE u.google_sub = p_google_sub OR u.email = p_email $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION wma_resolve_session(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION wma_find_user_identity(text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION wma_resolve_session(text) TO wma_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION wma_find_user_identity(text, text) TO wma_app;
