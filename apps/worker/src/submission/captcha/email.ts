const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface CaptchaEmailInput {
  companyName: string;
  jobTitle: string;
  link: string;
  image: Buffer;
}

/** The message that asks the user to read a challenge; the image is inline (`cid:captcha`). */
export function captchaEmail(input: CaptchaEmailInput) {
  const minutes = 15;
  const subject = `Your help needed: ${input.companyName} application (${input.jobTitle})`;
  const text = [
    `A security check came up while applying to ${input.jobTitle} at ${input.companyName}.`,
    '',
    `Open this link and type the characters you see in the picture within ${minutes} minutes:`,
    input.link,
    '',
    'The link works once.',
  ].join('\n');
  const html = [
    `<p>A security check came up while applying to <strong>${esc(input.jobTitle)}</strong> at ${esc(input.companyName)}.</p>`,
    '<p><img src="cid:captcha" alt="Security check" /></p>',
    `<p><a href="${esc(input.link)}">Type the characters you see</a> within ${minutes} minutes.</p>`,
    '<p>The link works once.</p>',
  ].join('\n');
  return {
    subject,
    text,
    html,
    attachments: [
      {
        filename: 'challenge.png',
        contentType: 'image/png',
        content: input.image,
        contentId: 'captcha',
      },
    ],
  };
}
