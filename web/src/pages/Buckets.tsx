import { useParams } from 'react-router-dom';
import { BucketList, BucketDetail } from '../components/BucketPanel';

export function BucketsPage() {
  const { name } = useParams<{ name: string }>();
  if (name) return <BucketDetail name={name} />;
  return <BucketList />;
}
