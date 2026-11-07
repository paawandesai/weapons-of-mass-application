import type { PrepPlan } from '../../api';

/** The four sections of a prep plan. */
export function PrepPlanView({ plan }: { plan: PrepPlan }) {
  return (
    <div className="prep-plan">
      <h2>Likely questions</h2>
      <ol>
        {plan.likely_questions.map((q, i) => (
          <li key={i}>
            <strong>{q.question}</strong>
            <p>{q.answer_outline}</p>
          </li>
        ))}
      </ol>
      <h2>Topics to review</h2>
      <ul>
        {plan.topics.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
      <h2>Company research</h2>
      <p style={{ whiteSpace: 'pre-wrap' }}>{plan.company_research}</p>
      <h2>Interviewer</h2>
      <p style={{ whiteSpace: 'pre-wrap' }}>
        {plan.interviewer_background ?? 'No interviewer information was found.'}
      </p>
    </div>
  );
}
