ALTER TABLE "tenants" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_slug_unique" UNIQUE("slug");--> statement-breakpoint
-- The demo flag has no application write path (task 8.5). The application role holds no UPDATE on
-- tenants at all (a column-level REVOKE would not undo the table-level grant), and a trigger
-- refuses an INSERT that sets the flag. Only the owner role, which runs the seed script, can.
REVOKE UPDATE ON tenants FROM wma_app;--> statement-breakpoint
CREATE FUNCTION wma_tenants_demo_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.demo AND current_user = 'wma_app' THEN
    RAISE EXCEPTION 'tenants.demo cannot be set by the application role' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER tenants_demo_guard BEFORE INSERT ON tenants
  FOR EACH ROW EXECUTE FUNCTION wma_tenants_demo_guard();
