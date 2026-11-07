-- Wave 2: grants and row-level security for the new tables. Runs as the owner role.
-- companies is the global ATS board cache: readable and writable by wma_app, no RLS.
GRANT SELECT, INSERT, UPDATE, DELETE ON companies TO wma_app;--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_companies','runs','run_candidates','jobs','applications','ats_credentials','captcha_requests'] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO wma_app', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_select ON %I FOR SELECT USING (tenant_id = current_setting(''app.tenant_id'')::uuid)', t);
    EXECUTE format('CREATE POLICY tenant_insert ON %I FOR INSERT WITH CHECK (tenant_id = current_setting(''app.tenant_id'')::uuid)', t);
    EXECUTE format('CREATE POLICY tenant_update ON %I FOR UPDATE USING (tenant_id = current_setting(''app.tenant_id'')::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'')::uuid)', t);
    EXECUTE format('CREATE POLICY tenant_delete ON %I FOR DELETE USING (tenant_id = current_setting(''app.tenant_id'')::uuid)', t);
  END LOOP;
END $$;--> statement-breakpoint
-- Pre-tenant lookup for the public CAPTCHA page: the visitor has only a token, so the tenant must be
-- learned from its hash before a handle exists. Like the session lookup, it returns identifiers only.
CREATE FUNCTION wma_resolve_captcha_token(p_token_hash text)
RETURNS TABLE (tenant_id uuid, request_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT c.tenant_id, c.id FROM public.captcha_requests c WHERE c.token_hash = p_token_hash $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION wma_resolve_captcha_token(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION wma_resolve_captcha_token(text) TO wma_app;
