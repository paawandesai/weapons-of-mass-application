export function origin(webOrigin: string): string {
  return webOrigin.replace(/\/+$/, '');
}

/** The application card, where the interview, its thread and the activity are shown. */
export const cardUrl = (webOrigin: string, applicationId: string) =>
  `${origin(webOrigin)}/applications/${applicationId}`;

/** The prep plan page of one interview (the web route `/interviews/:id/prep`). */
export const prepPlanUrl = (webOrigin: string, interviewId: string) =>
  `${origin(webOrigin)}/interviews/${interviewId}/prep`;

/** The feedback form of one interview (the web route `/interviews/:id/feedback`). */
export const feedbackUrl = (webOrigin: string, interviewId: string) =>
  `${origin(webOrigin)}/interviews/${interviewId}/feedback`;
