import { useParams } from 'react-router-dom';
import { DatabasesPanel } from '../components/DatabasesPanel';

export function DatabasesPage() {
  const { id } = useParams<{ id: string }>();
  return <DatabasesPanel activeId={id} />;
}
