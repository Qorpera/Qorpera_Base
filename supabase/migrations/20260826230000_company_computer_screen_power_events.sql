-- Screen power was added after view and keyframe auditing. Those earlier
-- migrations each replaced the event-type constraint with their then-current
-- list, so the deployed constraint does not yet admit the later open/close
-- events. Restore the complete append-only Company Computer event vocabulary.

alter table public.qorpera_company_computer_events
	drop constraint qorpera_company_computer_events_event_type_check;
alter table public.qorpera_company_computer_events
	add constraint qorpera_company_computer_events_event_type_check check (event_type in (
		'company_computer_registered', 'company_computer_lifecycle',
		'company_computer_screen_registered', 'company_computer_screen_attached',
		'company_computer_screen_detached', 'company_computer_screen_retired',
		'company_computer_screen_claimed', 'company_computer_screen_released',
		'company_computer_screen_viewed', 'company_computer_screen_keyframe',
		'company_computer_screen_opened', 'company_computer_screen_closed'
	));
