-- Wave 3: grants and row-level security for the inbox tables. Runs as the owner role.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['email_threads','processed_messages','interviews','interview_slots','outgoing_messages','mail_sync_state'] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO wma_app', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_select ON %I FOR SELECT USING (tenant_id = current_setting(''app.tenant_id'')::uuid)', t);
    EXECUTE format('CREATE POLICY tenant_insert ON %I FOR INSERT WITH CHECK (tenant_id = current_setting(''app.tenant_id'')::uuid)', t);
    EXECUTE format('CREATE POLICY tenant_update ON %I FOR UPDATE USING (tenant_id = current_setting(''app.tenant_id'')::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'')::uuid)', t);
    EXECUTE format('CREATE POLICY tenant_delete ON %I FOR DELETE USING (tenant_id = current_setting(''app.tenant_id'')::uuid)', t);
  END LOOP;
END $$;--> statement-breakpoint
-- Pre-tenant lookup for the public slot-confirm page: the visitor holds only a token, so the tenant
-- must be learned from its hash before a handle exists. Returns identifiers only.
CREATE FUNCTION wma_resolve_slot_token(p_token_hash text)
RETURNS TABLE (tenant_id uuid, slot_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT s.tenant_id, s.id FROM public.interview_slots s WHERE s.token_hash = p_token_hash $$;--> statement-breakpoint
-- Scheduler enumeration for the digest (application role, no tenant context): identifiers, the
-- local hour and the zone only.
CREATE FUNCTION wma_digest_roster()
RETURNS TABLE (tenant_id uuid, user_id uuid, digest_hour integer, timezone text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT u.tenant_id, u.id, u.digest_hour, u.timezone FROM public.users u WHERE u.approved_profile_version IS NOT NULL $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION wma_resolve_slot_token(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION wma_digest_roster() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION wma_resolve_slot_token(text) TO wma_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION wma_digest_roster() TO wma_app;
