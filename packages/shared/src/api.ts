import type { ProfileDocument, ProfileFlag, Survey, SurveySubmission } from './profile';

/** Survey fields plus the preference fields that live in the preferences section. */
export type SurveyAnswers = Survey & Pick<SurveySubmission, 'locations' | 'remote'>;

export type ConnectionKind = 'resume' | 'linkedin' | 'github' | 'drive' | 'gmail' | 'calendar';
export type ConnectionStatus = 'connected' | 'disconnected' | 'partial';

export interface Connection {
  kind: ConnectionKind;
  status: ConnectionStatus;
  config: Record<string, unknown> | null;
  connected_at: string | null;
}

export interface MeUser {
  id: string;
  email: string;
  display_name: string | null;
  approved_profile_version: number | null;
  approved_profile_at: string | null;
  daily_target: number;
  digest_hour: number;
}

export interface MeResponse {
  user: MeUser;
  connections: Connection[];
}

export interface BuildStatus {
  state: 'idle' | 'running' | 'done' | 'failed';
  version?: number;
  reason?: string;
}

export interface ProfileResponse {
  version: number;
  document: ProfileDocument;
  approved_version: number | null;
  approved_at: string | null;
  flags: ProfileFlag[];
  /** True when the latest version is not the approved one (rebuild or edit awaiting review). */
  pending_review?: boolean;
}

export interface ApiErrorBody {
  code: string;
  message: string;
}
