export const recordTypes = [
  'requirement',
  'design',
  'task',
  'check',
  'evidence',
  'review',
  'change',
  'problem',
  'knowledge',
] as const;
export type RecordType = (typeof recordTypes)[number];
export const linkTypes = [
  'derives-from',
  'satisfies',
  'implements',
  'verifies',
  'evidence-for',
  'reviews',
  'depends-on',
  'documents',
  'supersedes',
  'references',
] as const;
export type LinkType = (typeof linkTypes)[number];
export const statuses = [
  'draft',
  'ready',
  'in-progress',
  'submitted',
  'verified',
  'accepted',
  'blocked',
  'failed',
  'superseded',
  'candidate',
  'reviewed',
  'approved',
] as const;
export type Status = (typeof statuses)[number];
export type Profile = 'basic' | 'software' | 'embedded';
export type Platform = 'codex' | 'claude' | 'copilot';
export type Gate = 'ready' | 'design-ready' | 'verified' | 'accepted';
export interface Link {
  type: LinkType;
  target: string;
}
export interface Metadata {
  schema_version: 1;
  id: string;
  type: RecordType;
  title: string;
  owner: string;
  status: Status;
  revision: number;
  created_at: string;
  updated_at: string;
  links: Link[];
  data: Record<string, unknown>;
}
export interface ProjectRecord {
  meta: Metadata;
  body: string;
  path: string;
}
export interface ProjectConfig {
  schema_version: 1;
  project_id: string;
  name: string;
  profile: Profile;
  platforms: Platform[];
  models: Record<
    'economy' | 'balanced' | 'strong',
    string | null | Partial<Record<Platform, string>>
  >;
  max_workers: number;
  repair_attempts: number;
}
export interface Finding {
  code: string;
  record?: string;
  message: string;
}
export interface Verification {
  ok: boolean;
  gate: Gate;
  findings: Finding[];
  checked_at: string;
}
export interface CreateRecord {
  type: RecordType;
  title: string;
  owner?: string;
  status?: Status;
  body?: string;
  links?: Link[];
  data?: Record<string, unknown>;
}
