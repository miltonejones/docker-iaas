import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { LambdaFunction } from '../types';
import { api } from '../api';
import { onRefresh } from '../refresh';
import { AppIcon } from '../icons';
import { LambdaPanel } from '../components/LambdaPanel';

export function FunctionsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  // Detail view — /functions/:id
  if (id) {
    return (
      <LambdaPanel
        functionId={id === 'new' ? undefined : id}
        embedded
        onSaved={(newId) => navigate(`/functions/${newId}`, { replace: true })}
      />
    );
  }

  // List view — /functions
  return <FunctionList />;
}

function FunctionList() {
  const [functions, setFunctions] = useState<LambdaFunction[]>([]);
  const navigate = useNavigate();

  const loadFunctions = useCallback(async () => {
    try {
      setFunctions(await api.lambdaListFunctions());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => { loadFunctions(); }, [loadFunctions]);

  // Reload when the assistant mutates functions (create/delete/edit).
  useEffect(() => onRefresh(loadFunctions), [loadFunctions]);

  return (
    <section className="panel">
      <div className="panel__head">
        <h2>Functions <span className="count">{functions.length}</span></h2>
        <button
          className="btn btn--primary btn--sm"
          onClick={() => navigate('/functions/new')}
        >
          + New function
        </button>
      </div>

      {functions.length === 0 ? (
        <p className="empty">No functions yet. Create one to start running code in isolated containers.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Runtime</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {functions.map((fn) => (
                <tr
                  key={fn.id}
                  onClick={() => navigate(`/functions/${fn.id}`)}
                >
                  <td><AppIcon name="function" /> {fn.name}</td>
                  <td><span className="chip">{fn.runtime}</span></td>
                  <td className="muted">{new Date(fn.updatedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
