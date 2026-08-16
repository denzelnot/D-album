# D-Album

Семейный фотоальбом. Frontend — React + Vite, backend — Supabase (Auth, Database, Storage).

## Как выложить в интернет (без установки чего-либо на компьютер)

1. Зайдите на github.com, зарегистрируйтесь (бесплатно), создайте новый репозиторий (New repository), например `d-album`.
2. На странице репозитория нажмите "uploading an existing file" и перетащите туда все файлы из этой папки (сохраняя структуру: `src/`, `public/` и файлы в корне).
3. Зайдите на vercel.com, войдите через GitHub аккаунт.
4. "Add New..." → "Project" → выберите репозиторий `d-album` → Deploy.
   Vercel сам определит, что это Vite-проект, и всё соберёт.
5. Через минуту получите настоящий адрес вида `d-album.vercel.app`.
6. Откройте этот адрес на iPhone в Safari → кнопка "Поделиться" → "На экран «Домой»".

## SQL для Supabase (SQL Editor)

Выполнить один раз, если ещё не выполняли:

```sql
create table photos (
  id uuid primary key default gen_random_uuid(),
  uploaded_by text not null,
  owner_id uuid not null default auth.uid() references auth.users(id),
  file_path text not null,
  taken_at timestamptz,
  uploaded_at timestamptz default now(),
  lat double precision,
  lng double precision
);

alter table photos enable row level security;

create policy "Family can read photos"
on photos for select to authenticated using (true);

create policy "Members can insert own photos"
on photos for insert to authenticated with check (owner_id = auth.uid());

create policy "Members can delete own photos"
on photos for delete to authenticated using (owner_id = auth.uid());

create policy "Members can update own photos"
on photos for update to authenticated using (owner_id = auth.uid());

insert into storage.buckets (id, name, public) values ('photos', 'photos', false);

create policy "Family can view photos"
on storage.objects for select to authenticated using (bucket_id = 'photos');

create policy "Members can upload into own folder"
on storage.objects for insert to authenticated
with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Members can delete own files"
on storage.objects for delete to authenticated
using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
```
