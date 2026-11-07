export function origin(webOrigin: string): string {
  return webOrigin.replace(/\/+$/, '');
}

/** The application card, where the interview, its thread and the activity are shown. */
export const cardUrl = (webOrigin: string, applicationId: string) =>
  `${origin(webOrigin)}/applications/${applicationId}`;

export const prepPlanUrl = (webOrigin: string, applicationId: string) =>
  `${cardUrl(webOrigin, applicationId)}/prep`;
