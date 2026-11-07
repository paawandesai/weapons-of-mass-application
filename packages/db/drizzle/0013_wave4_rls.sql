-- Wave 4: grants and row-level security for the new tenant tables, plus the demo helpers.
-- Runs as the owner role.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stage_overrides','demo_mailbox_messages','demo_calendar_events'] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO wma_app', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_select ON %I FOR SELECT USING (tenant_id = current_setting(''app.tenant_id'')::uuid)', t);
    EXECUTE format('CREATE POLICY tenant_insert ON %I FOR INSERT WITH CHECK (tenant_id = current_setting(''app.tenant_id'')::uuid)', t);
    EXECUTE format('CREATE POLICY tenant_update ON %I FOR UPDATE USING (tenant_id = current_setting(''app.tenant_id'')::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'')::uuid)', t);
    EXECUTE format('CREATE POLICY tenant_delete ON %I FOR DELETE USING (tenant_id = current_setting(''app.tenant_id'')::uuid)', t);
  END LOOP;
END $$;--> statement-breakpoint
-- Next history id for one tenant's demo mailbox. SECURITY INVOKER: row-level security applies, so
-- the caller must hold that tenant's handle. The advisory lock serialises concurrent inserts for
-- the tenant until the surrounding transaction ends, so ids are strictly increasing and gap-free.
CREATE FUNCTION wma_demo_next_history_id(p_tenant uuid)
RETURNS bigint
LANGUAGE plpgsql VOLATILE
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('wma_demo_history:' || p_tenant::text, 0));
  RETURN (SELECT coalesce(max(history_id), 0) + 1 FROM demo_mailbox_messages WHERE tenant_id = p_tenant);
END $$;--> statement-breakpoint
-- Startup check: how many tenants carry the demo flag (more than one is a configuration error).
CREATE FUNCTION wma_demo_tenant_count()
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT count(*)::integer FROM public.tenants WHERE demo $$;--> statement-breakpoint
-- Demo sign-in: the single demo tenant's user. Empty unless exactly one tenant is flagged.
CREATE FUNCTION wma_demo_user()
RETURNS TABLE (tenant_id uuid, user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT u.tenant_id, u.id
  FROM public.users u
  JOIN public.tenants t ON t.id = u.tenant_id
  WHERE t.demo AND (SELECT count(*) FROM public.tenants WHERE demo) = 1
  ORDER BY u.created_at, u.id
  LIMIT 1
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION wma_demo_next_history_id(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION wma_demo_tenant_count() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION wma_demo_user() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION wma_demo_next_history_id(uuid) TO wma_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION wma_demo_tenant_count() TO wma_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION wma_demo_user() TO wma_app;
