import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { DashboardPage } from './pages/DashboardPage';
import { ProfileReviewPage } from './pages/ProfileReviewPage';
import { SignInPage } from './pages/SignInPage';
import { SurveyPage } from './pages/SurveyPage';

export function App() {
  return (
    <Routes>
      <Route path="/signin" element={<SignInPage />} />
      <Route element={<Layout />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/connections" element={<ConnectionsPage />} />
        <Route path="/survey" element={<SurveyPage />} />
        <Route path="/profile/review" element={<ProfileReviewPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
