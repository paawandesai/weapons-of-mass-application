export type BundleSourceKind = 'resume' | 'linkedin' | 'github' | 'drive';

/** One source as read once for a build; the same bundle feeds the model and post-validation. */
export interface BundleSource {
  /** `resume`, `linkedin`, `github` or `drive:<fileId>`. */
  id: string;
  kind: BundleSourceKind;
  text: string;
  /** True when the source returned nothing, or only part of what it should have. */
  partial: boolean;
  label?: string;
}

export interface SourceBundle {
  sources: BundleSource[];
  accountEmail: string;
  /** Profile links known from the connections (used only when the sources do not state them). */
  links: { linkedin_url: string | null; github_url: string | null };
}

export type BuildReason =
  'profile_build_no_resume' | 'profile_build_invalid_output' | 'profile_build_llm_error';

export class BuildError extends Error {
  constructor(
    readonly reason: BuildReason,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = 'BuildError';
  }
}

/** The build row is no longer this user's running build; nothing was published. */
export class BuildSupersededError extends Error {
  constructor(readonly buildId: string) {
    super(`profile build ${buildId} is no longer running`);
    this.name = 'BuildSupersededError';
  }
}
