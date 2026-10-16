-- 20260930310000: summary trees M4c (deploy/first-node/RUNTIME-AGENT-MEMORY-TREE.md §5.3, §5.5). An agent's run on a
-- post in a group chat it is in sees the primary view of the chat, as its run in its own thread does. The view
-- (qorpera_memory_view_of) and the branches (qorpera_memory_branch_list) already serve any conversation of a run (test
-- 971); only the companies' comment named own-thread runs.
set local lock_timeout = '3s';

comment on table public.qorpera_memory_tree_companies is
	'Summary trees M1 (RUNTIME-AGENT-MEMORY-TREE.md §5.3, M4c): the companies whose agents'' runs on a post in their own '
	'thread or a group chat see the primary view instead of the history. The coordinator lists a company once its trees '
	'are written.';
