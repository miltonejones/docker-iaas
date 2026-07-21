import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { AuthProvider } from './AuthContext';
import { ToastProvider } from './ToastContext';
import { initSpotlight } from './spotlight';
import './styles.css';

initSpotlight();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ToastProvider>
      <AuthProvider>
        <App />
      </AuthProvider>
    </ToastProvider>
  </React.StrictMode>,
);
