import { useParams } from 'react-router-dom';
import { GatewayList, GatewayDetail } from '../components/GatewayPanel';

export function GatewayPage() {
  const { name } = useParams<{ name: string }>();
  if (name) return <GatewayDetail name={name} />;
  return <GatewayList />;
}
