/**
 * Explicit inserts for the schema tests (MXN-392). Every column is named in
 * the SQL, and the values come from the record encoders by name, so a changed
 * column has to be changed here on purpose. Named parameters (`$column`) bind
 * from the row objects `records.ts` returns.
 *
 * Nothing in production inserts through these: they pin the schema and the
 * column/rest split until the importer lands.
 */
export const INSERT_THREAD = `INSERT INTO threads (
  id, project_id, title, title_source, hidden, interaction_mode, runtime_mode,
  model_instance, model_id, env_mode, env_path, env_branch,
  created_at, updated_at, archived_at, deleted_at, settled_at, settled_override,
  snoozed_until, snoozed_at, has_pending_approvals, has_pending_user_input,
  continued_from, usage_pause, rest
) VALUES (
  $id, $project_id, $title, $title_source, $hidden, $interaction_mode, $runtime_mode,
  $model_instance, $model_id, $env_mode, $env_path, $env_branch,
  $created_at, $updated_at, $archived_at, $deleted_at, $settled_at, $settled_override,
  $snoozed_until, $snoozed_at, $has_pending_approvals, $has_pending_user_input,
  $continued_from, $usage_pause, $rest
)`;

export const INSERT_TURN = `INSERT INTO turns (
  id, thread_id, message_id, status, delivery, scheduled_for, schedule_reason,
  held_at_settle, continue_attempt, queue_order, queue_removed, queue_automatic,
  queue_wake_up, queue_request_id, handoff_destination, owner_pid, owner_host,
  created_at, updated_at, completed_at, rest
) VALUES (
  $id, $thread_id, $message_id, $status, $delivery, $scheduled_for, $schedule_reason,
  $held_at_settle, $continue_attempt, $queue_order, $queue_removed, $queue_automatic,
  $queue_wake_up, $queue_request_id, $handoff_destination, $owner_pid, $owner_host,
  $created_at, $updated_at, $completed_at, $rest
)`;

export const INSERT_MESSAGE = `INSERT INTO messages (
  id, thread_id, turn_id, role, origin, created_at, text, original_text, attachments, notification
) VALUES (
  $id, $thread_id, $turn_id, $role, $origin, $created_at, $text, $original_text, $attachments, $notification
)`;

export const INSERT_ACTIVITY = `INSERT INTO activities (
  id, thread_id, turn_id, kind, summary, original_summary, created_at, payload, payload_encoding
) VALUES (
  $id, $thread_id, $turn_id, $kind, $summary, $original_summary, $created_at, $payload, $payload_encoding
)`;

export const INSERT_CHECKPOINT = `INSERT INTO checkpoints (
  id, thread_id, turn_id, status, ref, base_ref, created_at, files
) VALUES (
  $id, $thread_id, $turn_id, $status, $ref, $base_ref, $created_at, $files
)`;

export const INSERT_DELEGATION = `INSERT INTO delegations (
  id, parent_thread_id, child_thread_id, status, notify, continued_in,
  continues_task_id, idempotency_key, base_branch, prompt, created_at, updated_at, rest
) VALUES (
  $id, $parent_thread_id, $child_thread_id, $status, $notify, $continued_in,
  $continues_task_id, $idempotency_key, $base_branch, $prompt, $created_at, $updated_at, $rest
)`;

export const INSERT_META = "INSERT INTO meta (key, value) VALUES ($key, $value)";
