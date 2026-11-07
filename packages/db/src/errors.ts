/** Returned for a missing row and for a row of another tenant; the two are indistinguishable. */
export class NotFoundError extends Error {
  readonly code = 'not_found' as const;
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'NotFoundError';
  }
}

export class ProfileNotApprovedError extends Error {
  readonly code = 'profile_not_approved' as const;
  constructor(userId: string) {
    super(`profile_not_approved: user ${userId}`);
    this.name = 'ProfileNotApprovedError';
  }
}
