-- Salas de video privadas (21 oct 2026)
--
-- Antes: la señalizacion de la videollamada iba por un canal PUBLICO de
-- Supabase Realtime ('video-room-<ticket>'). Cualquiera con la clave publica
-- de la web y el ticket podia escuchar la negociacion y hasta entrar a la
-- sala. Ahora el canal es privado (private: true en la web) y estas
-- politicas solo dejan entrar a:
--   * el paciente dueño de la cita de ese ticket, o
--   * personal clinico (fila en public.staff).
-- Citas canceladas: nadie.
--
-- DESPUES de aplicar esto y publicar la web nueva, en el panel de Supabase:
--   Realtime → Settings → desactivar "Allow public access".
-- Sin ese paso los canales privados funcionan, pero alguien podria seguir
-- abriendo uno publico con el mismo nombre.
--
-- No borra nada ni cambia tablas existentes: solo añade un indice, una
-- funcion y dos politicas.

create index if not exists appointments_ticket_number_idx
  on public.appointments (ticket_number);

create or replace function public.puede_entrar_sala_video(p_topic text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null
     and p_topic like 'video-room-%'
     and exists (
       select 1
       from public.appointments a
       where a.ticket_number = substr(p_topic, 12)   -- 'video-room-' son 11 caracteres
         and a.status <> 'cancelled'
         and (a.user_id = auth.uid()
              or exists (select 1 from public.staff s where s.user_id = auth.uid()))
     );
$$;

revoke all on function public.puede_entrar_sala_video(text) from public;
revoke all on function public.puede_entrar_sala_video(text) from anon;
grant execute on function public.puede_entrar_sala_video(text) to authenticated;

drop policy if exists "video: leer solo participantes" on realtime.messages;
create policy "video: leer solo participantes"
  on realtime.messages for select to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and public.puede_entrar_sala_video((select realtime.topic()))
  );

drop policy if exists "video: enviar solo participantes" on realtime.messages;
create policy "video: enviar solo participantes"
  on realtime.messages for insert to authenticated
  with check (
    realtime.messages.extension in ('broadcast', 'presence')
    and public.puede_entrar_sala_video((select realtime.topic()))
  );
