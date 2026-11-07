# Demo video script

Target length three to four minutes. One numbered scene per paragraph: what is on screen, what
the viewer learns. `apps/web/e2e/record-demo.mts` records one clip per scene from this list and
`scripts/demo/narration/NN.txt` is the narration for scene NN. `scripts/demo/README.md` has the
commands.

What is real and what is not: every model call, form submission, email classification, booking
and prep plan in the video is the production code running against the seeded demo tenant
(`docs/DEMO.md`). The twelve employers are fictional and their recruiter is simulated by the
worker; the forms are local copies of the three vendor shapes. The long waits (form submissions,
the recruiter's reply, the prep plan) are cut out of the footage, not sped up or faked: the click
and the first second of the pending state stay in, and the footage resumes just before the result.

1. **Title card.** Weapons of Mass Application. An agent that runs a job search end to end: finds
   postings, decides, applies with a tailored resume, handles recruiter mail and books interviews
   only after you confirm a time.

2. **The profile.** Signed in as the demo user, Jordan Avery. Profile review: identity, work
   history, skills, preferences and the standard answers the agent is allowed to give on forms,
   all approved by the user before any application goes out. Connections: resume, LinkedIn,
   GitHub, Gmail and Calendar connected.

3. **Card: The daily run.**

4. **The run.** Runs page, "Run today". The twelve seeded postings are judged live: each candidate
   appears with a verdict and a one-line rationale; two are declined with their reason. The run
   view is ephemeral, a window on the day's work, not a queue.

5. **The board.** Ten cards land in Applied, seven applied and three with a Pending badge. One
   applied card opened: why this job, the tailored resume with the requirements it could not meet,
   the answers given on the form, the email thread, and the activity log. The Lumen Labs card is
   the one whose form showed a CAPTCHA; its activity log shows the stage that solved it. A pending
   card's log shows the question the profile could not answer ("Which of these have you used in
   production?"), which is why the agent stopped. (The wait for the submissions, about two
   minutes, is cut.)

6. **Card: The recruiter writes back.**

7. **The inbox.** The demo mailbox: a recruiter proposes three times for one of the roles. The
   agent read it, matched it to the card, and emailed the user one message with a confirm link
   per slot; it sent nothing to the recruiter. The user opens a link, sees the slot, and presses
   Confirm. (The wait for the recruiter is cut.)

8. **Booked.** Back on the board the card is in Interviewing. Its drawer shows the confirmed time,
   the reply the agent sent to the recruiter and the recruiter's acknowledgement, and the prep
   plan: likely questions, topics to review, company research, the interviewer. (The wait for
   the booking and the prep plan, under a minute, is cut.)

9. **End card.** Built in a day on Claude: twelve-hundred-plus tests, a simulated employer suite,
   and eight real applications submitted on 2026-11-07. Repository link.

## Recorded 2026-11-07

Third take on a fresh `wma_demo` (scripts/demo/stack.sh), commit 3b92246 plus the recording
tooling. Finished length 3:06 (185.9 s), 1440x900, H.264 and AAC, narrated with Kokoro
(`am_michael`). Cuts: 5.8 s of judging in scene 4, 116 s of form submissions in scene 5, 101 s
waiting for the recruiter in scene 7, 200 s for the booking, acknowledgement and prep plan in
scene 8. Scene 8's footage is time-compressed by 10 percent to its narration; nothing else is
sped up. Model spend for one pass is about one dollar.
