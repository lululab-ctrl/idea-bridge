-- Read-only "view as" sessions: the admin sees the app exactly as the idea
-- contributor does. impersonator_id is the admin who opened the preview.
alter table sessions add column if not exists impersonator_id integer references users(id) on delete cascade;
create index if not exists sessions_user_idx on sessions (user_id);
