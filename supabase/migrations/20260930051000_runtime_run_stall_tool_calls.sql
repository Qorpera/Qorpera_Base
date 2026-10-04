-- Session-buildup audit gap 4, a correction (found in the review of #792; coordinator decision 4 Oct): a tool call open
-- for 15 minutes is a run without progress like any other.
--
-- qorpera_run_no_progress_since (20260928459150) left out a run whose newest observation, "writing" pulses aside, was a
-- tool call's start (qorpera_run_waiting_on_tool), so that a long build would count as work. That exemption never fired:
-- every tool call records its context authority's start and finish right after its own start. Nor is it needed: no
-- built-in tool keeps a call open that long. Builds and commands go through machine_run and coding commands, which return
-- a handle at once; the longest waits inside a call are machine_read's (at most 300 s) and an action review's hold
-- (5 minutes). A tool call open for 15 minutes is a hang, and the contract tells a member of a run with no progress for
-- 15 minutes. Telling stops nothing.
-- * qorpera_run_no_progress_since no longer asks; qorpera_run_waiting_on_tool is dropped.
-- No lock. The body carries the marker 20260930051000.

create or replace function public.qorpera_run_no_progress_since(p_run_id uuid, p_started_at timestamptz)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
	-- Gap 4 (20260930002600): the run's last progress when it is at least qorpera_run_stall_minutes() old, else null. A tool
	-- call in flight is no exception (20260930051000).
	select progress.at
	from (select public.qorpera_run_last_progress_at(p_run_id, p_started_at) as at) as progress
	where progress.at <= statement_timestamp() - make_interval(mins => public.qorpera_run_stall_minutes())
$$;

drop function public.qorpera_run_waiting_on_tool(uuid);
