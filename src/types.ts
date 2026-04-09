// ── Central DB entities ──

export interface AgentGroup {
  id: string;
  name: string;
  folder: string;
  is_admin: number; // 0 | 1
  agent_provider: string | null;
  container_config: string | null; // JSON: { additionalMounts, timeout }
  created_at: string;
}

export interface MessagingGroup {
  id: string;
  channel_type: string;
  platform_id: string;
  name: string | null;
  is_group: number; // 0 | 1
  admin_user_id: string | null;
  created_at: string;
}

export interface MessagingGroupAgent {
  id: string;
  messaging_group_id: string;
  agent_group_id: string;
  trigger_rules: string | null; // JSON: { pattern, mentionOnly, excludeSenders, includeSenders }
  response_scope: 'all' | 'triggered' | 'allowlisted';
  session_mode: 'shared' | 'per-thread' | 'agent-shared';
  priority: number;
  created_at: string;
}

export interface Session {
  id: string;
  agent_group_id: string;
  messaging_group_id: string | null;
  thread_id: string | null;
  agent_provider: string | null;
  status: 'active' | 'closed';
  container_status: 'running' | 'idle' | 'stopped';
  last_active: string | null;
  created_at: string;
}

// ── Session DB entities ──

export type MessageInKind = 'chat' | 'chat-sdk' | 'task' | 'webhook' | 'system';
export type MessageInStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface MessageIn {
  id: string;
  kind: MessageInKind;
  timestamp: string;
  status: MessageInStatus;
  status_changed: string | null;
  process_after: string | null;
  recurrence: string | null;
  tries: number;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string; // JSON blob
}

export interface MessageOut {
  id: string;
  in_reply_to: string | null;
  timestamp: string;
  delivered: number; // 0 | 1
  deliver_after: string | null;
  recurrence: string | null;
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string; // JSON blob
}

// ── Pending questions (central DB) ──

export interface PendingQuestion {
  question_id: string;
  session_id: string;
  message_out_id: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  created_at: string;
}
