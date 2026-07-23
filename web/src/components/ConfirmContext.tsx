import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

interface ConfirmOptions {
  message: string;
  confirmLabel?: string;
  variant?: 'danger' | 'info';
}

interface ConfirmState extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

interface ConfirmContextValue {
  askConfirm: (message: string, options?: { confirmLabel?: string; variant?: 'danger' | 'info' }) => Promise<boolean>;
  showAlert: (message: string) => Promise<void>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be inside <ConfirmProvider>');
  return ctx;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConfirmState | null>(null);

  const askConfirm = useCallback(
    (message: string, options?: { confirmLabel?: string; variant?: 'danger' | 'info' }) =>
      new Promise<boolean>((resolve) => {
        setState({ message, resolve, confirmLabel: options?.confirmLabel, variant: options?.variant || 'danger' });
      }),
    [],
  );

  const showAlert = useCallback(
    (message: string) =>
      new Promise<void>((resolve) => {
        setState({ message, resolve: () => resolve(), confirmLabel: undefined, variant: 'info' });
      }),
    [],
  );

  const close = useCallback((result: boolean) => {
    state?.resolve(result);
    setState(null);
  }, [state]);

  return (
    <ConfirmContext.Provider value={{ askConfirm, showAlert }}>
      {children}
      {state && (
        <div className="modal-backdrop" onClick={() => close(false)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <p className="confirm-dialog__message">{state.message}</p>
            <div className="confirm-dialog__actions">
              {state.confirmLabel !== undefined ? (
                <>
                  <button className="btn btn--ghost btn--sm" onClick={() => close(false)}>Cancel</button>
                  <button
                    className={`btn ${state.variant === 'danger' ? 'btn--danger' : 'btn--primary'} btn--sm`}
                    onClick={() => close(true)}
                  >
                    {state.confirmLabel || 'OK'}
                  </button>
                </>
              ) : (
                <button className="btn btn--primary btn--sm" onClick={() => close(true)}>OK</button>
              )}
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
