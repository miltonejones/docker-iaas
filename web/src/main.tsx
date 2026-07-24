import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { AuthProvider } from './AuthContext';
import { ConfirmProvider } from './components/ConfirmContext';
import { ToastProvider } from './ToastContext';
import { initSpotlight } from './spotlight';
import './styles.css';

initSpotlight();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ToastProvider>
      <AuthProvider>
        <ConfirmProvider>
          <App />
        </ConfirmProvider>
      </AuthProvider>
    </ToastProvider>
  </React.StrictMode>,
);
