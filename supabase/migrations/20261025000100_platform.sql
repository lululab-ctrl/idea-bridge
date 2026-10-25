-- Supabase-specific setup: private storage buckets and the once-a-minute
-- scheduler that wakes the background worker. Written defensively so the same
-- migrations also run on a plain local Postgres for testing.

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('audio', 'audio', false, 26214400), ('files', 'files', false, 26214400)
    on conflict (id) do nothing;
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net with schema extensions;
    create extension if not exists pg_cron with schema pg_catalog;
    -- The worker address and secret are written to `settings` by the api
    -- function itself on start-up, so nothing project-specific lives here.
    perform cron.schedule(
      'idea-bridge-worker',
      '* * * * *',
      $cron$
        select net.http_post(
          url := (select value::jsonb #>> '{}' from public.settings where key = 'worker_url'),
          headers := jsonb_build_object(
            'content-type', 'application/json',
            'x-worker-secret', (select value::jsonb #>> '{}' from public.settings where key = 'worker_secret')
          ),
          body := '{}'::jsonb,
          timeout_milliseconds := 5000
        )
        where exists (select 1 from public.settings where key = 'worker_url');
      $cron$
    );
  end if;
end $$;
