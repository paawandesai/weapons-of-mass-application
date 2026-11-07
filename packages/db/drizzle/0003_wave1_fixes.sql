CREATE UNIQUE INDEX "profile_builds_one_running_key" ON "profile_builds" USING btree ("user_id") WHERE "profile_builds"."state" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "source_connections_tenant_user_kind_key" ON "source_connections" USING btree ("tenant_id","user_id","kind");--> statement-breakpoint
-- Sign-in matches an existing account by the stable Google subject only. Email collisions are
-- detected separately so a recycled address never authenticates another tenant.
DROP FUNCTION wma_find_user_identity(text, text);--> statement-breakpoint
CREATE FUNCTION wma_find_user_by_sub(p_google_sub text)
RETURNS TABLE (tenant_id uuid, user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT u.tenant_id, u.id FROM public.users u WHERE u.google_sub = p_google_sub $$;--> statement-breakpoint
CREATE FUNCTION wma_email_exists(p_email text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT EXISTS (SELECT 1 FROM public.users u WHERE u.email = p_email) $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION wma_find_user_by_sub(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION wma_email_exists(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION wma_find_user_by_sub(text) TO wma_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION wma_email_exists(text) TO wma_app;
