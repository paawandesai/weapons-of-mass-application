import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ApplicationPage } from './pages/ApplicationPage';
import { BoardPage } from './pages/BoardPage';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { DashboardPage } from './pages/DashboardPage';
import { DemoInboxPage } from './pages/DemoInboxPage';
import { FeedbackPage } from './pages/FeedbackPage';
import { PrepPlanPage } from './pages/PrepPlanPage';
import { ProfileReviewPage } from './pages/ProfileReviewPage';
import { RunViewPage } from './pages/RunViewPage';
import { SignInPage } from './pages/SignInPage';
import { SurveyPage } from './pages/SurveyPage';

export function App() {
  return (
    <Routes>
      <Route path="/signin" element={<SignInPage />} />
      <Route element={<Layout />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/board" element={<BoardPage />} />
        <Route path="/runs" element={<RunViewPage />} />
        <Route path="/applications/:id" element={<ApplicationPage />} />
        <Route path="/interviews/:id/feedback" element={<FeedbackPage />} />
        <Route path="/interviews/:id/prep" element={<PrepPlanPage />} />
        <Route path="/demo/inbox" element={<DemoInboxPage />} />
        <Route path="/connections" element={<ConnectionsPage />} />
        <Route path="/survey" element={<SurveyPage />} />
        <Route path="/profile/review" element={<ProfileReviewPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
