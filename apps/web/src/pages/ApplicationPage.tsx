import { Link, useParams } from 'react-router-dom';
import { BoardDetail } from '../components/BoardDetail';

export function ApplicationPage() {
  const { id } = useParams();
  return (
    <section>
      <p>
        <Link to="/board">Back to the board</Link>
      </p>
      {id ? <BoardDetail id={id} /> : <p className="muted">This application could not be found.</p>}
    </section>
  );
}
